import { z } from 'zod';

/**
 * Router definitions (PM/research/11 §5.2). Pure and browser-safe: the API
 * validates drafts and versions with it, the engine runs it, the web builder
 * edits it. `steps: []` is a pass-through router (decided at ingress).
 */

/** Attribute keys: `language`, `product`, … (lower snake case). */
export const ATTRIBUTE_KEY = /^[a-z][a-z0-9_]{0,39}$/;
export const AttrKey = z.string().regex(ATTRIBUTE_KEY, 'attribute keys are lower snake case (a-z, 0-9, _), at most 40 characters');

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'step ids are 1–40 letters, digits, - or _');
const Uuid = z.uuid();

/** Text sent to the customer, with an optional approved template per channel for outside the session window. */
export const MessageSpecSchema = z.object({
  text: z.string().trim().min(1).max(1_000),
  /** channelId → message_templates.id, sent instead of `text` when the channel's session window is closed. */
  templates: z.record(Uuid, Uuid).optional(),
});
export type MessageSpec = z.infer<typeof MessageSpecSchema>;

export const AskOptionSchema = z.object({
  value: z.string().trim().min(1).max(60),
  label: z.string().trim().min(1).max(60),
  synonyms: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
});
export type AskOption = z.infer<typeof AskOptionSchema>;

export const AskStepSchema = z.object({
  id: Id,
  kind: z.literal('ASK'),
  attribute: AttrKey,
  prompt: MessageSpecSchema,
  options: z.array(AskOptionSchema).min(2).max(10),
  maxAttempts: z.number().int().min(1).max(5),
  skipIfKnown: z.boolean(),
});

export const ClassifyStepSchema = z.object({
  id: Id,
  kind: z.literal('CLASSIFY'),
  attribute: AttrKey,
  modelProfileId: Uuid,
  instructions: z.string().trim().max(4_000),
  labels: z
    .array(z.object({ value: z.string().trim().min(1).max(60), description: z.string().trim().max(500) }))
    .min(2)
    .max(20),
  minConfidence: z.number().min(0).max(1),
  maxFollowUps: z.number().int().min(0).max(3),
  skipIfKnown: z.boolean(),
});

/** `customer.language` or `customer.attribute:<key>` (a customer attribute the host or a tool set). */
export const KnownSourceSchema = z.union([z.literal('customer.language'), z.string().regex(/^customer\.attribute:[A-Za-z0-9_.-]{1,60}$/)]);
export const KnownStepSchema = z.object({ id: Id, kind: z.literal('KNOWN'), attribute: AttrKey, from: KnownSourceSchema });

export const RouterStepSchema = z.discriminatedUnion('kind', [AskStepSchema, ClassifyStepSchema, KnownStepSchema]);
export type RouterStep = z.infer<typeof RouterStepSchema>;
export type AskStep = z.infer<typeof AskStepSchema>;
export type ClassifyStep = z.infer<typeof ClassifyStepSchema>;
export type KnownStep = z.infer<typeof KnownStepSchema>;

/** All keys must match; an array matches any of its values. An empty `when` matches everything. */
export const RouterRuleSchema = z.object({
  when: z.record(AttrKey, z.union([z.string().min(1).max(60), z.array(z.string().min(1).max(60)).min(1).max(20)])),
  queueId: Uuid,
});
export type RouterRule = z.infer<typeof RouterRuleSchema>;

export const RETURNING_UNITS = ['HOURS', 'DAYS', 'MONTHS'] as const;
export const ReturningSchema = z.object({
  askAfter: z.object({ value: z.number().int().min(1).max(1_000), unit: z.enum(RETURNING_UNITS) }),
  prompt: MessageSpecSchema,
  continueLabel: z.string().trim().min(1).max(20),
  newLabel: z.string().trim().min(1).max(20),
});
export type ReturningConfig = z.infer<typeof ReturningSchema>;

export const RouterDefinitionSchema = z
  .object({
    steps: z.array(RouterStepSchema).max(10),
    rules: z.array(RouterRuleSchema).max(100),
    fallbackQueueId: Uuid,
    returning: ReturningSchema.nullable(),
    timeoutMinutes: z.number().int().min(1).max(1_440),
  })
  .superRefine((def, ctx) => {
    for (const problem of structuralProblems(def)) ctx.addIssue({ code: 'custom', message: problem.message, path: problem.path });
  });
export type RouterDefinition = z.infer<typeof RouterDefinitionSchema>;

export interface DefinitionProblem {
  path: Array<string | number>;
  message: string;
}

const norm = (s: string) => s.trim().toLowerCase();

/** Rules the zod shape cannot say: unique step ids, options and labels; continue ≠ new. */
export function structuralProblems(def: Pick<RouterDefinition, 'steps' | 'returning'>): DefinitionProblem[] {
  const problems: DefinitionProblem[] = [];
  const ids = new Set<string>();
  def.steps.forEach((step, i) => {
    if (ids.has(step.id)) problems.push({ path: ['steps', i, 'id'], message: `step id ${step.id} is used twice` });
    ids.add(step.id);
    if (step.kind === 'ASK') {
      const values = step.options.map((o) => norm(o.value));
      const labels = step.options.map((o) => norm(o.label));
      if (new Set(values).size !== values.length) problems.push({ path: ['steps', i, 'options'], message: 'option values must be unique within a step' });
      if (new Set(labels).size !== labels.length) problems.push({ path: ['steps', i, 'options'], message: 'option labels must be unique within a step' });
    }
    if (step.kind === 'CLASSIFY') {
      const values = step.labels.map((l) => norm(l.value));
      if (new Set(values).size !== values.length) problems.push({ path: ['steps', i, 'labels'], message: 'label values must be unique within a step' });
    }
  });
  if (def.returning && norm(def.returning.continueLabel) === norm(def.returning.newLabel)) {
    problems.push({ path: ['returning', 'newLabel'], message: 'the continue and new labels must differ' });
  }
  return problems;
}

/** A router with no steps decides at ingress (the fallback, or a rule that matches no attributes). */
export function isPassThrough(def: Pick<RouterDefinition, 'steps'>): boolean {
  return def.steps.length === 0;
}

/** Everything a definition points at, for activation checks and dependency hashes. */
export function routerReferences(def: RouterDefinition): { queueIds: string[]; modelProfileIds: string[]; templates: Array<{ channelId: string; templateId: string }> } {
  const queueIds = new Set<string>([def.fallbackQueueId, ...def.rules.map((r) => r.queueId)]);
  const modelProfileIds = new Set<string>(def.steps.flatMap((s) => (s.kind === 'CLASSIFY' ? [s.modelProfileId] : [])));
  const specs: MessageSpec[] = [...def.steps.flatMap((s) => (s.kind === 'ASK' ? [s.prompt] : [])), ...(def.returning ? [def.returning.prompt] : [])];
  const templates = specs.flatMap((spec) => Object.entries(spec.templates ?? {}).map(([channelId, templateId]) => ({ channelId, templateId })));
  return { queueIds: [...queueIds], modelProfileIds: [...modelProfileIds], templates };
}

/** The pass-through definition a new router starts from. */
export function passThroughDefinition(fallbackQueueId: string): RouterDefinition {
  return { steps: [], rules: [], fallbackQueueId, returning: null, timeoutMinutes: 10 };
}
