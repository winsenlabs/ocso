'use server';

import { refresh } from 'next/cache';
import { z } from 'zod';
import { ProposedSchema } from '@/components/approvals/lib/schemas';
import { ALERT_KINDS, ALERT_SEVERITIES, AUDIENCE_ROLES } from '../api/alerts';
import { api } from '../api/client';
import { ApiError, describeApiError } from '../api/errors';
import { getSession } from '../session';

/**
 * Alert rules under maker–checker (PM/research/11 §4): a new rule is a disabled
 * draft; turning it on, changing an approved rule and deleting answer
 * `approval_required` until `approval` names a checker (then 202, a proposal);
 * turning a rule off applies at once. Kinds `alert_rule` (business) and
 * `alert_rule_technical`. The API is the enforcement point.
 */
export type RuleActionResult<T = null> = { ok: true; data: T } | { ok: false; message: string; code?: string | undefined };
/** A write that became a proposal (202). */
export type RuleProposed = { proposalId: string; title: string };

const Id = z.uuid();
const Approval = z.union([z.object({ checkerId: Id, reason: z.string().trim().min(3).max(500) }), z.object({ bootstrap: z.literal(true), reason: z.string().trim().min(3).max(500).optional() })]);
export type RuleApproval = z.input<typeof Approval>;
const enc = encodeURIComponent;
const Proposed = ProposedSchema.transform((b): RuleProposed => ({ proposalId: b.proposal.id, title: b.proposal.title }));
const Saved = z.union([Proposed, z.object({ id: z.string() }).transform(() => null)]);
const withApproval = (approval: z.infer<typeof Approval> | undefined) => (approval ? { approval } : {});

async function run<I, T>(schema: z.ZodType<I>, raw: unknown, call: (input: I) => Promise<T>): Promise<RuleActionResult<T>> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ') };
  if (!(await getSession())) return { ok: false, message: 'Your session has ended. Sign in again.' };
  try {
    const data = await call(parsed.data);
    refresh();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, message: describeApiError(err), code: err instanceof ApiError ? err.code : undefined };
  }
}

const RuleInput = z.object({
  name: z.string().trim().min(1, 'Enter a rule name').max(160),
  kind: z.enum(ALERT_KINDS),
  condition: z.string().trim().min(1, 'Choose a condition').max(64),
  params: z.record(z.string(), z.unknown()),
  windowSeconds: z.number().int(),
  severity: z.enum(ALERT_SEVERITIES),
  audienceRoles: z.array(z.enum(AUDIENCE_ROLES)).min(1, 'Choose at least one audience role'),
  destinationIds: z.array(Id),
  dedupeWindowSeconds: z.number().int(),
  autoResolve: z.boolean(),
});
export type RuleFormInput = z.infer<typeof RuleInput>;

/** Creates the rule off (a draft); turning it on is a separate, approved step. */
export async function createAlertRuleAction(input: RuleFormInput): Promise<RuleActionResult<{ id: string }>> {
  return run(RuleInput, input, async (i) => ({ id: (await api.post('/v1/alert-rules', i, z.object({ id: z.string() }))).id }));
}

/** A draft changes directly; an approved rule's change is a proposal once `approval` names a checker. */
export async function updateAlertRuleAction(id: string, input: RuleFormInput, approval?: RuleApproval): Promise<RuleActionResult<RuleProposed | null>> {
  return run(z.object({ id: Id, body: RuleInput, approval: Approval.optional() }), { id, body: input, approval }, async (i) =>
    api.patch(`/v1/alert-rules/${enc(i.id)}`, { ...i.body, ...withApproval(i.approval) }, Saved),
  );
}

/** Off applies at once; on (and back on) is always a proposal. */
export async function setAlertRuleEnabledAction(id: string, enabled: boolean, approval?: RuleApproval): Promise<RuleActionResult<RuleProposed | null>> {
  return run(z.object({ id: Id, enabled: z.boolean(), approval: Approval.optional() }), { id, enabled, approval }, async (i) =>
    api.patch(`/v1/alert-rules/${enc(i.id)}`, { enabled: i.enabled, ...withApproval(i.approval) }, Saved),
  );
}

/** Deleting is always a proposal; once approved, the rule's open alerts are resolved. */
export async function deleteAlertRuleAction(id: string, approval?: RuleApproval): Promise<RuleActionResult<RuleProposed | null>> {
  return run(z.object({ id: Id, approval: Approval.optional() }), { id, approval }, async (i) => api.delete(`/v1/alert-rules/${enc(i.id)}`, withApproval(i.approval), Proposed));
}
