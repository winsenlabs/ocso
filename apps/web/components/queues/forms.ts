/**
 * Form parsing for queues and SLA policies (pure; used by the server actions
 * and unit-tested). Mirrors QueueInput / SlaPolicyInput in packages/
 * application/src/routing/queues.ts so the API rarely has to reject a form.
 */
import { z } from 'zod';

export const CONVERSATION_TYPES = ['SUPPORT', 'SALES', 'COLLECTIONS', 'ONBOARDING', 'CUSTOM'] as const;
export const PRIORITY_KEYS = ['P1', 'P2', 'P3', 'P4'] as const;

type Result<T> = { ok: true; data: T } | { ok: false; fieldErrors: Record<string, string> };

function errorsOf(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) out[String(i.path[0] ?? 'form')] ??= i.message;
  return out;
}

/** "cards, emi ,, disputes" → ["cards", "emi", "disputes"] (deduplicated, order kept). */
export function splitList(value: string): string[] {
  return [...new Set(value.split(',').map((s) => s.trim()).filter(Boolean))];
}

/** Optional number field: '' → null, otherwise a number (NaN when not numeric, so zod reports it). */
function optionalNumber(value: string): number | null {
  const t = value.trim();
  return t === '' ? null : Number(t);
}

const Uuid = z.uuid('Choose from the list');

const QueueForm = z
  .object({
    name: z.string().trim().min(1, 'Enter a queue name').max(120, 'At most 120 characters'),
    description: z.string().trim().max(500, 'At most 500 characters'),
    mode: z.enum(['OPEN_PICKUP', 'AUTO_ASSIGN'], 'Choose a routing mode'),
    autoAssignAfterSeconds: z.number('Enter seconds').int('Whole seconds').min(10, 'At least 10 seconds').max(86_400, 'At most 24 hours').nullable(),
    acceptTimeoutSeconds: z.number('Enter seconds').int('Whole seconds').min(15, 'At least 15 seconds').max(3_600, 'At most 1 hour'),
    requiredSkills: z.array(z.string().max(60, 'Skills are at most 60 characters')).max(20, 'At most 20 skills'),
    languages: z.array(z.string().max(20, 'Language codes are at most 20 characters')).max(20, 'At most 20 languages'),
    preferAccountOwner: z.boolean(),
    slaPolicyId: Uuid.nullable(),
    teamIds: z.array(Uuid).max(50),
  })
  .transform((q) => ({ ...q, description: q.description || null, autoAssignAfterSeconds: q.mode === 'OPEN_PICKUP' ? q.autoAssignAfterSeconds : null }));
export type QueueFormData = z.output<typeof QueueForm>;

export interface QueueFormFields {
  name: string;
  description: string;
  mode: string;
  autoAssignAfterSeconds: string;
  acceptTimeoutSeconds: string;
  requiredSkills: string;
  languages: string;
  preferAccountOwner: boolean;
  slaPolicyId: string;
  teamIds: string[];
}

export function parseQueueForm(f: QueueFormFields): Result<QueueFormData> {
  const accept = f.acceptTimeoutSeconds.trim() === '' ? 120 : Number(f.acceptTimeoutSeconds);
  const parsed = QueueForm.safeParse({
    name: f.name,
    description: f.description,
    mode: f.mode,
    autoAssignAfterSeconds: optionalNumber(f.autoAssignAfterSeconds),
    acceptTimeoutSeconds: accept,
    requiredSkills: splitList(f.requiredSkills),
    languages: splitList(f.languages),
    preferAccountOwner: f.preferAccountOwner,
    slaPolicyId: f.slaPolicyId || null,
    teamIds: f.teamIds,
  });
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, fieldErrors: errorsOf(parsed.error.issues) };
}

/* ───────────── SLA policies: minutes / hours in the form, seconds in the API ───────────── */

export interface SlaFormFields {
  name: string;
  /** Minutes. */
  firstHumanResponse: string;
  /** Minutes per priority; blank = use the first-response target. */
  pickup: Partial<Record<(typeof PRIORITY_KEYS)[number], string>>;
  /** Hours per conversation type; blank = no resolution target. */
  resolution: Partial<Record<(typeof CONVERSATION_TYPES)[number], string>>;
  /** Percent of the window, e.g. "75". */
  atRiskPercent: string;
}

export interface SlaFormData {
  name: string;
  firstHumanResponseSeconds: number;
  pickupSecondsByPriority: Partial<Record<(typeof PRIORITY_KEYS)[number], number>>;
  resolutionSecondsByType: Record<string, number>;
  atRiskFraction: number;
}

export function parseSlaForm(f: SlaFormFields): Result<SlaFormData> {
  const errors: Record<string, string> = {};
  const name = f.name.trim();
  if (!name) errors['name'] = 'Enter a policy name';
  else if (name.length > 120) errors['name'] = 'At most 120 characters';

  const minutes = (key: string, raw: string | undefined, required: boolean): number | null => {
    const t = (raw ?? '').trim();
    if (!t) {
      if (required) errors[key] = 'Enter minutes';
      return null;
    }
    const s = Math.round(Number(t) * 60);
    if (!Number.isFinite(s)) errors[key] = 'Enter a number of minutes';
    else if (s < 30) errors[key] = 'At least 0.5 minutes';
    else if (s > 604_800) errors[key] = 'At most 7 days (10080 minutes)';
    else return s;
    return null;
  };

  const first = minutes('firstHumanResponse', f.firstHumanResponse, true);
  const pickup: SlaFormData['pickupSecondsByPriority'] = {};
  for (const p of PRIORITY_KEYS) {
    const s = minutes(`pickup${p}`, f.pickup[p], false);
    if (s !== null) pickup[p] = s;
  }
  const resolution: Record<string, number> = {};
  for (const t of CONVERSATION_TYPES) {
    const raw = (f.resolution[t] ?? '').trim();
    if (!raw) continue;
    const s = Math.round(Number(raw) * 3_600);
    if (!Number.isFinite(s)) errors[`resolution${t}`] = 'Enter a number of hours';
    else if (s < 60) errors[`resolution${t}`] = 'At least 1 minute (0.02 h)';
    else if (s > 2_592_000) errors[`resolution${t}`] = 'At most 30 days (720 h)';
    else resolution[t] = s;
  }
  const pct = f.atRiskPercent.trim() === '' ? 75 : Number(f.atRiskPercent);
  if (!Number.isFinite(pct) || pct < 10 || pct > 99) errors['atRiskPercent'] = 'Between 10 and 99 percent';

  if (Object.keys(errors).length || first === null) return { ok: false, fieldErrors: errors };
  return { ok: true, data: { name, firstHumanResponseSeconds: first, pickupSecondsByPriority: pickup, resolutionSecondsByType: resolution, atRiskFraction: Math.round(pct) / 100 } };
}

/** Seconds → the minutes the form shows ("15", "0.5"). */
export function toMinutes(seconds: number | undefined): string {
  if (seconds === undefined) return '';
  const m = seconds / 60;
  return Number.isInteger(m) ? String(m) : m.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/** Seconds → the hours the form shows ("4", "0.25"). */
export function toHours(seconds: number | undefined): string {
  if (seconds === undefined) return '';
  const h = seconds / 3_600;
  return Number.isInteger(h) ? String(h) : h.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}
