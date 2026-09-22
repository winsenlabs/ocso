'use server';

import { refresh } from 'next/cache';
import { Permission } from '@ocso/auth';
import { z } from 'zod';
import { COMPONENT_KEYS, CONVERSATION_TYPES, ESCALATION_TRIGGERS, PRIORITIES, RULE_OPS } from '@/components/agents/data/agent-schemas';
import { hoursIssues, type BusinessHours, type HoursIssues } from '@/components/agents/lib/business-hours';
import { api } from '../api/client';
import { describeApiError } from '../api/errors';
import { getSession } from '../session';

/**
 * Virtual-agent configuration (design/02): agent settings, prompt drafts and
 * versions, escalation rules, tool grants, corrections and replay
 * evaluations. Inputs are validated here and again by the API, which is the
 * enforcement point; every change is audited there.
 */

export type ActionResult<T = null> = { ok: true; data: T } | { ok: false; message: string };

const Id = z.uuid();
const enc = encodeURIComponent;
const agentPath = (id: string) => `/v1/agents/${enc(id)}`;

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
    return { ok: false, message: describeApiError(err) };
  }
}

// ─────────── Agent ───────────

const Profile = Id.nullable();
const AgentFields = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(80),
  purpose: z.string().trim().max(200),
  conversationType: z.enum(CONVERSATION_TYPES),
  description: z.string().max(2_000),
  modelProfileId: Profile,
  summarizerProfileId: Profile,
  copilotProfileId: Profile,
  defaultQueueId: Id.nullable(),
  multimodal: z.object({ imageInput: z.boolean(), documentInput: z.boolean(), audioInput: z.boolean(), maxMediaPerTurn: z.number().int().min(0).max(20) }),
  midTurnPolicy: z.enum(['QUEUE_BEHIND', 'CANCEL_AND_RESTART']),
  maxToolSteps: z.number().int().min(1, 'Max tool steps: 1–20').max(20, 'Max tool steps: 1–20'),
  copilotEnabled: z.boolean(),
  channelIds: z.array(Id),
});
export type AgentFieldsInput = z.input<typeof AgentFields>;
const OwnerTeams = z.array(Id).min(1, 'Choose at least one owning team').max(20);
const NewAgent = AgentFields.pick({ name: true, purpose: true, conversationType: true, description: true, modelProfileId: true, defaultQueueId: true, channelIds: true }).extend({
  /** Owning teams (ADR-026): teams the lead belongs to; the API rejects others. */
  teamIds: OwnerTeams,
});
export type NewAgentInput = z.input<typeof NewAgent>;

export async function createAgentAction(input: NewAgentInput): Promise<ActionResult<{ id: string }>> {
  return run(Permission.AGENTS_MANAGE, 'create virtual agents', NewAgent, input, async (body) => {
    const channelIds = body.channelIds.length ? { channelIds: body.channelIds } : {};
    const agent = await api.post('/v1/agents', { ...body, ...channelIds }, z.object({ id: z.string() }));
    return { id: agent.id };
  });
}

export async function updateAgentAction(id: string, patch: Partial<AgentFieldsInput>): Promise<ActionResult> {
  return run(Permission.AGENTS_MANAGE, 'change virtual agents', z.object({ id: Id, patch: AgentFields.partial() }), { id, patch }, async (i) => {
    await api.patch(agentPath(i.id), i.patch, z.object({ id: z.string() }));
    return null;
  });
}

/** Shape only: time zone, HH:MM and open < close are validated by the API so its messages drive the inline errors. */
const HoursBody = z.object({
  timezone: z.string().trim().min(1, 'Choose a time zone').max(64),
  humanHours: z.record(z.string().max(3), z.tuple([z.string().max(5), z.string().max(5)])),
});
export type HoursActionResult = { ok: true; data: null } | { ok: false; message: string; fields: HoursIssues };

/** Agent business hours: when humans take handoffs (`humanHours: {}` = humans 24×7; the AI answers 24×7). */
export async function updateBusinessHoursAction(id: string, hours: BusinessHours): Promise<HoursActionResult> {
  const result = await run(Permission.AGENTS_MANAGE, 'change business hours', z.object({ id: Id, hours: HoursBody }), { id, hours }, async (i) => {
    await api.patch(agentPath(i.id), { businessHours: i.hours }, z.object({ id: z.string() }));
    return null;
  });
  if (result.ok) return result;
  const { fields, other } = hoursIssues(result.message.replace(/(^|; )hours\./g, '$1businessHours.'));
  return { ok: false, message: other.join('; '), fields };
}

/**
 * Replace an agent's owning teams (PUT /v1/agents/:id/owners). A CS Lead may
 * change only teams they belong to; the Tech Admin (agents.assign_owner) may
 * reassign any team. The API enforces the rules and audits the change.
 */
export async function setAgentOwnersAction(id: string, teamIds: string[]): Promise<ActionResult> {
  const session = await getSession();
  const permission = session?.permissions.has(Permission.AGENTS_ASSIGN_OWNER) ? Permission.AGENTS_ASSIGN_OWNER : Permission.AGENTS_MANAGE;
  return run(permission, 'change owning teams', z.object({ id: Id, teamIds: OwnerTeams }), { id, teamIds }, async (i) => {
    await api.put(`${agentPath(i.id)}/owners`, { teamIds: i.teamIds }, z.object({ id: z.string() }));
    return null;
  });
}

export async function setAgentStatusAction(id: string, status: 'LIVE' | 'PAUSED'): Promise<ActionResult> {
  return run(Permission.AGENTS_MANAGE, 'pause or start virtual agents', z.object({ id: Id, status: z.enum(['LIVE', 'PAUSED']) }), { id, status }, async (i) => {
    await api.post(`${agentPath(i.id)}/status`, { status: i.status }, z.object({ id: z.string() }));
    return null;
  });
}

// ─────────── Prompt ───────────

const Components = z.object(Object.fromEntries(COMPONENT_KEYS.map((k) => [k, z.string().max(20_000, `${k}: at most 20,000 characters`)])) as Record<(typeof COMPONENT_KEYS)[number], z.ZodString>);

export async function saveDraftAction(agentId: string, components: Record<string, string>): Promise<ActionResult> {
  return run(Permission.PROMPTS_EDIT, 'edit prompts', z.object({ agentId: Id, components: Components }), { agentId, components }, async (i) => {
    await api.command('PUT', `${agentPath(i.agentId)}/prompt/draft`, i.components);
    return null;
  });
}

export async function discardDraftAction(agentId: string): Promise<ActionResult> {
  return run(Permission.PROMPTS_EDIT, 'edit prompts', Id, agentId, async (id) => {
    await api.command('DELETE', `${agentPath(id)}/prompt/draft`);
    return null;
  });
}

const VersionInput = z.object({
  agentId: Id,
  reason: z.string().trim().min(3, 'Give a reason of at least 3 characters').max(500),
  correctionIds: z.array(Id).max(50),
});

export async function createVersionAction(agentId: string, reason: string, correctionIds: string[]): Promise<ActionResult<{ id: string; version: number }>> {
  return run(Permission.PROMPTS_EDIT, 'create prompt versions', VersionInput, { agentId, reason, correctionIds }, async (i) => {
    const body = i.correctionIds.length ? { reason: i.reason, correctionIds: i.correctionIds } : { reason: i.reason };
    return api.post(`${agentPath(i.agentId)}/prompt/versions`, body, z.object({ id: z.string(), version: z.number() }));
  });
}

/** Activation and rollback are the same call: make this version the live one. */
export async function activateVersionAction(agentId: string, versionId: string): Promise<ActionResult> {
  return run(Permission.PROMPTS_ACTIVATE, 'activate prompt versions', z.object({ agentId: Id, versionId: Id }), { agentId, versionId }, async (i) => {
    await api.command('POST', `${agentPath(i.agentId)}/prompt/versions/${enc(i.versionId)}/activate`);
    return null;
  });
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
  enabled: z.boolean(),
});
export type RuleInputT = z.input<typeof RuleInput>;

export async function saveRuleAction(agentId: string, ruleId: string | null, input: Partial<RuleInputT>): Promise<ActionResult> {
  const schema = z.object({ agentId: Id, ruleId: Id.nullable(), body: ruleId ? RuleInput.partial() : RuleInput });
  return run(Permission.ESCALATION_MANAGE, 'manage escalation rules', schema, { agentId, ruleId, body: input }, async (i) => {
    const base = `${agentPath(i.agentId)}/escalation-rules`;
    if (i.ruleId) await api.put(`${base}/${enc(i.ruleId)}`, i.body, z.object({ id: z.string() }));
    else await api.post(base, i.body, z.object({ id: z.string() }));
    return null;
  });
}

export async function deleteRuleAction(agentId: string, ruleId: string): Promise<ActionResult> {
  return run(Permission.ESCALATION_MANAGE, 'manage escalation rules', z.object({ agentId: Id, ruleId: Id }), { agentId, ruleId }, async (i) => {
    await api.command('DELETE', `${agentPath(i.agentId)}/escalation-rules/${enc(i.ruleId)}`);
    return null;
  });
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

export async function setToolGrantsAction(agentId: string, grants: GrantInput[]): Promise<ActionResult> {
  return run(Permission.AGENT_TOOLS_MANAGE, 'change agent tools', z.object({ agentId: Id, grants: z.array(Grant).max(500) }), { agentId, grants }, async (i) => {
    await api.put(`${agentPath(i.agentId)}/tools`, { grants: i.grants }, z.object({ agentId: z.string() }));
    return null;
  });
}

// ─────────── Corrections (docs/09 §7) ───────────

const CorrectionInput = z.object({
  agentId: Id,
  title: z.string().trim().min(3, 'Title: at least 3 characters').max(200),
  observed: z.string().trim().min(3, 'Observed: at least 3 characters').max(2_000),
  desired: z.string().trim().min(3, 'Desired: at least 3 characters').max(2_000),
  componentKey: z.enum(COMPONENT_KEYS),
  proposedText: z.string().trim().max(20_000).optional(),
});
export type CorrectionInputT = z.input<typeof CorrectionInput>;

export async function createCorrectionAction(input: CorrectionInputT): Promise<ActionResult<{ merged: boolean }>> {
  return run(Permission.CORRECTIONS_MANAGE, 'record prompt corrections', CorrectionInput, input, async (body) => {
    const { proposedText, ...rest } = body;
    const res = await api.post('/v1/corrections', proposedText ? { ...rest, proposedText } : rest, z.object({ id: z.string(), merged: z.boolean() }));
    return { merged: res.merged };
  });
}

export async function stageCorrectionAction(id: string, proposedText: string, mode: 'APPEND' | 'REPLACE'): Promise<ActionResult> {
  const schema = z.object({ id: Id, proposedText: z.string().trim().min(1, 'Enter the text to stage into the draft').max(20_000), mode: z.enum(['APPEND', 'REPLACE']) });
  return run(Permission.CORRECTIONS_MANAGE, 'stage prompt corrections', schema, { id, proposedText, mode }, async (i) => {
    await api.post(`/v1/corrections/${enc(i.id)}/stage`, { proposedText: i.proposedText, mode: i.mode }, z.object({ componentKey: z.string() }));
    return null;
  });
}

export async function rejectCorrectionAction(id: string, reason: string): Promise<ActionResult> {
  return run(Permission.CORRECTIONS_MANAGE, 'reject prompt corrections', z.object({ id: Id, reason: z.string().trim().max(500) }), { id, reason }, async (i) => {
    await api.command('POST', `/v1/corrections/${enc(i.id)}/reject`, i.reason ? { reason: i.reason } : {});
    return null;
  });
}

// ─────────── Replay evaluations ───────────

export async function startEvaluationAction(agentId: string, caseCount: number): Promise<ActionResult<{ id: string }>> {
  const schema = z.object({ agentId: Id, caseCount: z.number().int().min(1, 'Cases: 1–200').max(200, 'Cases: 1–200') });
  return run(Permission.EVALUATIONS_RUN, 'run replay evaluations', schema, { agentId, caseCount }, async (i) => {
    const res = await api.post('/v1/evaluations', { agentId: i.agentId, source: 'DRAFT', caseCount: i.caseCount }, z.object({ id: z.string() }));
    return { id: res.id };
  });
}
