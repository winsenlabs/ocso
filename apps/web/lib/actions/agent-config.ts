'use server';

import { refresh } from 'next/cache';
import { Permission } from '@ocso/auth';
import { z } from 'zod';
import { ESCALATION_TRIGGERS, PRIORITIES, RULE_OPS } from '@/components/agents/data/agent-schemas';
import { ProposedSchema } from '@/components/approvals/lib/schemas';
import { api } from '../api/client';
import { ApiError, describeApiError } from '../api/errors';
import { getSession } from '../session';
import type { ActionResult, ApprovalChoice, Proposed } from './agents';

/**
 * An agent's escalation rules and tool grants under maker–checker
 * (PM/research/11 §4): drafts change directly; turning a rule on, changing an
 * approved one, deleting, and granting tools to an approved agent answer
 * `approval_required` until `approval` names a checker (then 202, a proposal).
 * Turning a rule off and removing or narrowing a tool apply at once.
 */

const Id = z.uuid();
const Approval = z.union([z.object({ checkerId: Id, reason: z.string().trim().min(3).max(500) }), z.object({ bootstrap: z.literal(true), reason: z.string().trim().min(3).max(500).optional() })]);
const enc = encodeURIComponent;
const agentPath = (id: string) => `/v1/agents/${enc(id)}`;
const toProposed = (b: z.infer<typeof ProposedSchema>): Proposed => ({ proposalId: b.proposal.id, title: b.proposal.title, status: b.proposal.status });
const withApproval = (approval: z.infer<typeof Approval> | undefined) => (approval ? { approval } : {});

async function run<I, T>(permission: Permission, what: string, schema: z.ZodType<I>, raw: unknown, call: (input: I) => Promise<T>): Promise<ActionResult<T>> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ') };
  const session = await getSession();
  if (!session) return { ok: false, message: 'Your session has ended. Sign in again.' };
  if (!session.permissions.has(permission)) return { ok: false, message: `Your role cannot ${what}.` };
  try {
    const data = await call(parsed.data);
    refresh();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, message: describeApiError(err), code: err instanceof ApiError ? err.code : undefined };
  }
}

// ─────────── Escalation rules ───────────

const RuleInput = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(120),
  trigger: z.enum(ESCALATION_TRIGGERS),
  condition: z.object({
    keywords: z.array(z.string().trim().min(2).max(80)).max(50).optional(),
    consecutiveToolFailures: z.number().int().min(1).max(10).optional(),
    customerRequestsHuman: z.boolean().optional(),
    amountAbove: z.number().positive().optional(),
  }),
  mode: z.enum(['AUTO_ASSIGN', 'OPEN_PICKUP']),
  targetQueueId: Id.nullable(),
  priority: z.enum(PRIORITIES),
});
export type RuleInputT = z.input<typeof RuleInput>;
const RuleResult = z.union([ProposedSchema.transform(toProposed), z.object({ id: z.string() }).transform(() => null)]);

/** Save a rule: a new one is created off (a draft); an approved one's change is a proposal once `approval` names a checker. */
export async function saveRuleAction(agentId: string, ruleId: string | null, input: Partial<RuleInputT>, approval?: ApprovalChoice): Promise<ActionResult<Proposed | null>> {
  const schema = z.object({ agentId: Id, ruleId: Id.nullable(), body: ruleId ? RuleInput.partial() : RuleInput, approval: Approval.optional() });
  return run(Permission.ESCALATION_MANAGE, 'manage escalation rules', schema, { agentId, ruleId, body: input, approval }, async (i) => {
    const base = `${agentPath(i.agentId)}/escalation-rules`;
    if (!i.ruleId) {
      await api.post(base, i.body, z.object({ id: z.string() }));
      return null;
    }
    return api.put(`${base}/${enc(i.ruleId)}`, { ...i.body, ...withApproval(i.approval) }, RuleResult);
  });
}

/** Turning a rule on (or back on) is always a proposal; turning it off applies at once. */
export async function setRuleEnabledAction(agentId: string, ruleId: string, enabled: boolean, approval?: ApprovalChoice): Promise<ActionResult<Proposed | null>> {
  const schema = z.object({ agentId: Id, ruleId: Id, enabled: z.boolean(), approval: Approval.optional() });
  return run(Permission.ESCALATION_MANAGE, 'manage escalation rules', schema, { agentId, ruleId, enabled, approval }, async (i) =>
    api.put(`${agentPath(i.agentId)}/escalation-rules/${enc(i.ruleId)}`, { enabled: i.enabled, ...withApproval(i.approval) }, RuleResult),
  );
}

/** Deleting a rule is always a proposal. */
export async function deleteRuleAction(agentId: string, ruleId: string, approval?: ApprovalChoice): Promise<ActionResult<Proposed | null>> {
  return run(Permission.ESCALATION_MANAGE, 'manage escalation rules', z.object({ agentId: Id, ruleId: Id, approval: Approval.optional() }), { agentId, ruleId, approval }, async (i) =>
    api.delete(`${agentPath(i.agentId)}/escalation-rules/${enc(i.ruleId)}`, withApproval(i.approval), ProposedSchema.transform(toProposed)),
  );
}

// ─────────── Tool grants ───────────

const Grant = z.object({
  toolId: Id,
  enabled: z.boolean(),
  alwaysConfirm: z.boolean(),
  argumentRules: z
    .array(z.object({ path: z.string().min(1), op: z.enum(RULE_OPS), value: z.unknown().optional(), effect: z.enum(['REQUIRE_CONFIRMATION', 'DENY']), message: z.string().trim().min(1).max(300) }))
    .max(20, 'At most 20 argument rules per tool'),
});
export type GrantInput = z.input<typeof Grant>;

/** What a save did: removals and narrowing apply at once; what widens access became a proposal (when `proposal` is set). */
export interface GrantsSaved {
  applied: { removed: number; narrowed: number };
  proposal: Proposed | null;
}
const GrantsResponse = z.object({
  applied: z.object({ removed: z.array(z.string()), narrowed: z.array(z.string()) }).partial().optional(),
  proposal: ProposedSchema.shape.proposal.nullable().optional(),
});

/** A draft agent's set applies whole; an approved agent's widening part answers `approval_required` until a checker is named. */
export async function setToolGrantsAction(agentId: string, grants: GrantInput[], approval?: ApprovalChoice): Promise<ActionResult<GrantsSaved>> {
  const schema = z.object({ agentId: Id, grants: z.array(Grant).max(500), approval: Approval.optional() });
  return run(Permission.AGENT_TOOLS_MANAGE, 'change agent tools', schema, { agentId, grants, approval }, async (i) => {
    const res = await api.put(`${agentPath(i.agentId)}/tools`, { grants: i.grants, ...withApproval(i.approval) }, GrantsResponse);
    return {
      applied: { removed: res.applied?.removed?.length ?? 0, narrowed: res.applied?.narrowed?.length ?? 0 },
      proposal: res.proposal ? toProposed({ proposal: res.proposal }) : null,
    };
  });
}
