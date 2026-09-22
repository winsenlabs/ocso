/**
 * Review and correction form parsing (pure; server actions + unit tests).
 * Mirrors ReviewInput / CorrectionInput in packages/application/src/quality.
 */
import { z } from 'zod';

export const COMPONENTS = ['identity', 'objective', 'behavior', 'policies', 'tool_instructions', 'escalation', 'channel_constraints', 'business_context'] as const;
export type Component = (typeof COMPONENTS)[number];

/** Prompt component names as design/02 prints them. */
export const COMPONENT_LABELS: Readonly<Record<string, string>> = {
  identity: 'Identity',
  objective: 'Objective',
  behavior: 'Behavior',
  policies: 'Policies and compliance',
  tool_instructions: 'Tool instructions',
  escalation: 'Escalation rules',
  channel_constraints: 'Channel constraints',
  business_context: 'Business context',
};

export const RUBRIC_KEYS = ['accuracy', 'policy', 'tone', 'resolution'] as const;
export type RubricKey = (typeof RUBRIC_KEYS)[number];

type Result<T> = { ok: true; data: T } | { ok: false; fieldErrors: Record<string, string> };

function errorsOf(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) out[String(i.path[0] ?? 'form')] ??= i.message;
  return out;
}

const Criterion = z.number('Score 1–5').int('Score 1–5').min(1, 'Score 1–5').max(5, 'Score 1–5');
const ReviewForm = z.object({
  conversationId: z.uuid('Choose a conversation'),
  accuracy: Criterion,
  policy: Criterion,
  tone: Criterion,
  resolution: Criterion,
  outcomeTag: z.string().trim().min(1, 'Enter an outcome tag').max(60, 'At most 60 characters'),
  notes: z.string().trim().max(4_000, 'At most 4000 characters'),
});

export interface ReviewFormData {
  conversationId: string;
  rubric: Record<RubricKey, number>;
  outcomeTag: string;
  notes?: string;
}

export function parseReviewForm(f: Record<string, string>): Result<ReviewFormData> {
  const score = (k: string) => (f[k] ? Number(f[k]) : Number.NaN);
  const parsed = ReviewForm.safeParse({
    conversationId: f['conversationId'] ?? '',
    accuracy: score('accuracy'),
    policy: score('policy'),
    tone: score('tone'),
    resolution: score('resolution'),
    outcomeTag: f['outcomeTag'] ?? '',
    notes: f['notes'] ?? '',
  });
  if (!parsed.success) return { ok: false, fieldErrors: errorsOf(parsed.error.issues) };
  const d = parsed.data;
  return {
    ok: true,
    data: {
      conversationId: d.conversationId,
      rubric: { accuracy: d.accuracy, policy: d.policy, tone: d.tone, resolution: d.resolution },
      outcomeTag: d.outcomeTag,
      ...(d.notes ? { notes: d.notes } : {}),
    },
  };
}

/** Preview of the API's score formula (mean of the four criteria, 2 decimals); null until all are set. */
export function rubricPreview(values: Partial<Record<RubricKey, number>>): number | null {
  const scores = RUBRIC_KEYS.map((k) => values[k]);
  if (scores.some((s) => s === undefined)) return null;
  const sum = (scores as number[]).reduce((s, v) => s + v, 0);
  return Math.round((sum / scores.length) * 100) / 100;
}

const CorrectionForm = z
  .object({
    agentId: z.uuid('Choose a virtual agent').optional(),
    conversationId: z.uuid('Not a conversation id').optional(),
    interactionSeq: z.number('Enter a turn number').int('Whole turn number').min(1, 'Turns start at 1').optional(),
    title: z.string().trim().min(3, 'At least 3 characters').max(200, 'At most 200 characters').optional(),
    observed: z.string().trim().min(3, 'Describe what happened (3+ characters)').max(2_000, 'At most 2000 characters'),
    desired: z.string().trim().min(3, 'Describe what should happen (3+ characters)').max(2_000, 'At most 2000 characters'),
    componentKey: z.enum(COMPONENTS, 'Choose the prompt component'),
    proposedText: z.string().trim().min(1).max(20_000, 'At most 20000 characters').optional(),
  })
  .refine((v) => v.agentId || v.conversationId, { message: 'Choose a virtual agent', path: ['agentId'] })
  .refine((v) => v.interactionSeq === undefined || v.conversationId, { message: 'A turn needs a source conversation', path: ['interactionSeq'] });
export type CorrectionFormData = z.output<typeof CorrectionForm>;

/** Blank optional fields are omitted (the API treats absent and blank differently). */
export function parseCorrectionForm(f: Record<string, string>): Result<CorrectionFormData> {
  const opt = (k: string) => {
    const v = (f[k] ?? '').trim();
    return v ? v : undefined;
  };
  const seq = opt('interactionSeq');
  const raw = {
    agentId: opt('agentId'),
    conversationId: opt('conversationId'),
    interactionSeq: seq === undefined ? undefined : Number(seq),
    title: opt('title'),
    observed: f['observed'] ?? '',
    desired: f['desired'] ?? '',
    componentKey: f['componentKey'] ?? '',
    proposedText: opt('proposedText'),
  };
  const parsed = CorrectionForm.safeParse(Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)));
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, fieldErrors: errorsOf(parsed.error.issues) };
}
