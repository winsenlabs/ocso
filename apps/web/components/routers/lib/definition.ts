import { RouterDefinitionSchema, type RouterDefinition, type RouterRule, type RouterStep } from '@ocso/domain';

/**
 * Router builder model (PM/research/11 §5.2, §5.7). Pure and client-safe: the
 * builder edits a RouterDefinition directly; these helpers add steps with
 * sensible defaults, round-trip rule conditions through the text the rule
 * editor shows (`language=ta, product=sales|loans`), generate rules from the
 * queues' attributes, and report problems with paths the form can show.
 * The API re-validates everything with the same schema.
 */

export type StepKind = RouterStep['kind'];

export const RETURNING_UNITS = ['HOURS', 'DAYS', 'MONTHS'] as const;

/** A short machine id from a label: `Tamil Sales` → `tamil_sales` (never empty). */
export function slug(label: string, fallback = 'x'): string {
  const s = label
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return s || fallback;
}

/** An id not yet used by a step: `ask`, `ask_2`, … */
export function uniqueStepId(base: string, steps: readonly RouterStep[]): string {
  const ids = new Set(steps.map((s) => s.id));
  if (!ids.has(base)) return base;
  for (let n = 2; ; n++) if (!ids.has(`${base}_${n}`)) return `${base}_${n}`;
}

/** A new step of this kind with defaults that pass the schema once its blanks are filled. */
export function newStep(kind: StepKind, steps: readonly RouterStep[], modelProfileId = ''): RouterStep {
  if (kind === 'ASK') {
    return {
      id: uniqueStepId('ask', steps),
      kind: 'ASK',
      attribute: 'language',
      prompt: { text: 'Which language would you like to continue in?' },
      options: [
        { value: 'en', label: 'English' },
        { value: 'ta', label: 'Tamil' },
      ],
      maxAttempts: 2,
      skipIfKnown: true,
    };
  }
  if (kind === 'CLASSIFY') {
    return {
      id: uniqueStepId('classify', steps),
      kind: 'CLASSIFY',
      attribute: 'product',
      modelProfileId,
      instructions: 'Decide what the customer needs help with.',
      labels: [
        { value: 'cards', description: 'Credit and debit cards, EMI, card blocks' },
        { value: 'loans', description: 'Loans, applications, repayments' },
      ],
      minConfidence: 0.7,
      maxFollowUps: 1,
      skipIfKnown: true,
    };
  }
  return { id: uniqueStepId('known', steps), kind: 'KNOWN', attribute: 'language', from: 'customer.language' };
}

/** Attribute keys the steps can set (what rules may test), in step order, unique. */
export function stepAttributes(def: Pick<RouterDefinition, 'steps'>): string[] {
  return [...new Set(def.steps.map((s) => s.attribute))];
}

/** Values a step offers for an attribute (ASK options, CLASSIFY labels); empty for KNOWN. */
export function attributeValues(def: Pick<RouterDefinition, 'steps'>, attribute: string): string[] {
  const out: string[] = [];
  for (const s of def.steps) {
    if (s.attribute !== attribute) continue;
    if (s.kind === 'ASK') out.push(...s.options.map((o) => o.value));
    if (s.kind === 'CLASSIFY') out.push(...s.labels.map((l) => l.value));
  }
  return [...new Set(out)];
}

/** `when` → the rule editor's text: `language=ta, product=sales|loans`. */
export function formatWhen(when: RouterRule['when']): string {
  return Object.entries(when)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`)
    .join(', ');
}

/** The rule editor's text → `when`, or the first problem. Blank = matches everything. */
export function parseWhen(text: string): { ok: true; when: RouterRule['when'] } | { ok: false; message: string } {
  const when: Record<string, string | string[]> = {};
  for (const part of text.split(',').map((p) => p.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq <= 0) return { ok: false, message: `“${part}”: write attribute=value` };
    const key = part.slice(0, eq).trim();
    const values = part
      .slice(eq + 1)
      .split('|')
      .map((v) => v.trim())
      .filter(Boolean);
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) return { ok: false, message: `“${key}”: attribute names are lower case letters, digits and _` };
    if (!values.length) return { ok: false, message: `${key}: give at least one value` };
    if (key in when) return { ok: false, message: `${key} appears twice` };
    when[key] = values.length === 1 ? values[0]! : values;
  }
  return { ok: true, when };
}

export interface QueueRef {
  id: string;
  name: string;
  attributes: Readonly<Record<string, string>>;
}

/**
 * One rule per queue whose attributes are all set by the steps, most specific
 * first (more attributes before fewer) — the "language menu over attribute
 * queues" shape. Queues without attributes are left for the fallback.
 */
export function rulesFromQueues(def: Pick<RouterDefinition, 'steps'>, queues: readonly QueueRef[]): RouterRule[] {
  const known = new Set(stepAttributes(def));
  return queues
    .filter((q) => Object.keys(q.attributes).length > 0 && Object.keys(q.attributes).every((k) => known.has(k)))
    .sort((a, b) => Object.keys(b.attributes).length - Object.keys(a.attributes).length || a.name.localeCompare(b.name))
    .map((q) => ({ when: { ...q.attributes }, queueId: q.id }));
}

/** Rules that test an attribute no step sets: they can never match. */
export function unreachableRules(def: Pick<RouterDefinition, 'steps' | 'rules'>): number[] {
  const known = new Set(stepAttributes(def));
  return def.rules.flatMap((r, i) => (Object.keys(r.when).some((k) => !known.has(k)) ? [i] : []));
}

export interface DefinitionIssue {
  path: string;
  message: string;
}

/** Schema problems with dotted paths (`steps.0.options.1.label`), for inline errors before saving. */
export function definitionIssues(def: unknown): DefinitionIssue[] {
  const parsed = RouterDefinitionSchema.safeParse(def);
  return parsed.success ? [] : parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/** Map an approved template to a message for one channel (or clear it with null). */
export function withTemplate<T extends { text: string; templates?: Record<string, string> | undefined }>(spec: T, channelId: string, templateId: string | null): T {
  const templates = { ...(spec.templates ?? {}) };
  if (templateId) templates[channelId] = templateId;
  else delete templates[channelId];
  const { templates: _t, ...rest } = spec;
  return (Object.keys(templates).length ? { ...rest, templates } : rest) as T;
}

/** A template name for a router message: `<router>_<step>` in provider-safe characters. */
export function templateName(routerName: string, stepId: string): string {
  return `${slug(routerName, 'router')}_${slug(stepId, 'message')}`.slice(0, 512);
}

export const KIND_LABELS: Readonly<Record<string, string>> = { PASS_THROUGH: 'Pass-through', MENU: 'Menu', MODEL: 'Model', MIXED: 'Menu + model' };
