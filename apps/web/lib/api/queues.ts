import 'server-only';
import { z } from 'zod';
import { api } from './client';
import { notYetAvailable } from './pending';
import { ProposedSchema } from '@/components/approvals/lib/schemas';

/* ───────────── Queues and SLA policies (apps/api routing.controller.ts, packages/application routing/queues.ts) ───────────── */

export const QUEUE_MODES = ['OPEN_PICKUP', 'AUTO_ASSIGN'] as const;
export type QueueMode = (typeof QUEUE_MODES)[number];
export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Maker–checker summary on list rows (PM/research/11 §4): approved, and the open proposal if any. */
export const ApprovalSummarySchema = z
  .object({ approved: z.boolean(), pending: z.object({ id: z.string(), action: z.string(), checkerName: z.string().nullable() }).nullable() })
  .default({ approved: false, pending: null });
export type ApprovalSummary = z.infer<typeof ApprovalSummarySchema>;

export const BusinessHoursSchema = z.object({ timezone: z.string(), humanHours: z.record(z.string(), z.tuple([z.string(), z.string()])) });
export type QueueHours = z.infer<typeof BusinessHoursSchema>;

/** QueueView from GET /v1/queues: configuration plus live counts. */
export const QueueSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  mode: z.enum(QUEUE_MODES),
  autoAssignAfterSeconds: z.number().nullable(),
  acceptTimeoutSeconds: z.number(),
  requiredSkills: z.array(z.string()),
  languages: z.array(z.string()),
  preferAccountOwner: z.boolean(),
  slaPolicyId: z.string().nullable(),
  teamIds: z.array(z.string()),
  waiting: z.number(),
  oldestWaitingSince: z.string().nullable(),
  onShift: z.number(),
  members: z.number(),
  /** Conversations waiting for a human past their SLA right now. */
  breaches: z.number(),
  /** The queue's one AI agent (PM/research/11 §5.5). */
  agentId: z.string().nullable().default(null),
  /** What the queue serves, e.g. { language: 'ta' } (unique across queues). */
  attributes: z.record(z.string(), z.string()).default({}),
  /** When humans take handoffs; null = the agent's hours. */
  businessHours: BusinessHoursSchema.nullable().default(null),
  transferTargetIds: z.array(z.string()).default([]),
  approval: ApprovalSummarySchema,
});
export type Queue = z.infer<typeof QueueSchema>;

export const SlaPolicySchema = z.object({
  id: z.string(),
  name: z.string(),
  firstHumanResponseSeconds: z.number(),
  pickupSecondsByPriority: z.partialRecord(z.enum(PRIORITIES), z.number()),
  resolutionSecondsByType: z.record(z.string(), z.number()),
  atRiskFraction: z.number(),
  updatedAt: z.string().nullable().default(null),
  approval: ApprovalSummarySchema,
});
export type SlaPolicy = z.infer<typeof SlaPolicySchema>;

/** Body of POST /v1/queues (QueueInput); PATCH takes any subset. */
export interface QueueRequest {
  name: string;
  description: string | null;
  mode: QueueMode;
  autoAssignAfterSeconds: number | null;
  acceptTimeoutSeconds: number;
  requiredSkills: string[];
  languages: string[];
  preferAccountOwner: boolean;
  slaPolicyId: string | null;
  teamIds: string[];
  agentId?: string | null | undefined;
  attributes?: Record<string, string> | undefined;
  businessHours?: QueueHours | null | undefined;
  transferTargetIds?: string[] | undefined;
}

/** The maker's choice from the submit-for-approval modal. */
export type ApprovalBody = { checkerId: string; reason: string } | { bootstrap: true; reason?: string | undefined };

/** Body of POST/PUT /v1/sla-policies (SlaPolicyInput). */
export interface SlaPolicyRequest {
  name: string;
  firstHumanResponseSeconds: number;
  pickupSecondsByPriority: Partial<Record<Priority, number>>;
  resolutionSecondsByType: Record<string, number>;
  atRiskFraction: number;
}

const Created = z.object({ id: z.string() });

export function listQueues(): Promise<Queue[]> {
  return api.get('/v1/queues', z.array(QueueSchema));
}

export function listSlaPolicies(): Promise<SlaPolicy[]> {
  return api.get('/v1/sla-policies', z.array(SlaPolicySchema));
}

export async function createQueue(input: QueueRequest): Promise<string> {
  return (await api.post('/v1/queues', input, Created)).id;
}

/** A proposal's id and title when the write became one (202). */
export type Proposed = { proposalId: string; title: string } | null;
const proposedOf = (body: unknown): Proposed => {
  const parsed = ProposedSchema.safeParse(body);
  return parsed.success ? { proposalId: parsed.data.proposal.id, title: parsed.data.proposal.title } : null;
};
const Answer = z.unknown();

/** PATCH: stops apply at once; the rest applies to a draft, or becomes a proposal with `approval` (else 409 approval_required). */
export async function updateQueue(id: string, patch: Partial<QueueRequest>, approval?: ApprovalBody, baseline?: QueueBaseline): Promise<Proposed> {
  const res = await api.patch(`/v1/queues/${encodeURIComponent(id)}`, { ...patch, ...(approval ? { approval } : {}), ...(baseline ? { baseline } : {}) }, Answer.optional());
  return proposedOf(res);
}

/** First approval of a draft queue (CREATE): always a proposal. */
export async function submitQueue(id: string, approval: ApprovalBody): Promise<Proposed> {
  return proposedOf(await api.post(`/v1/queues/${encodeURIComponent(id)}/submit`, { approval }, Answer));
}

export async function saveSlaPolicy(id: string | null, input: SlaPolicyRequest, approval?: ApprovalBody): Promise<{ id: string; proposed: Proposed }> {
  const body = { ...input, ...(approval ? { approval } : {}) };
  const res = id ? await api.put(`/v1/sla-policies/${encodeURIComponent(id)}`, body, Created.passthrough()) : await api.post('/v1/sla-policies', body, Created.passthrough());
  return { id: res.id, proposed: proposedOf(res) };
}

export async function submitSlaPolicy(id: string, approval: ApprovalBody): Promise<Proposed> {
  return proposedOf(await api.post(`/v1/sla-policies/${encodeURIComponent(id)}/submit`, { approval }, Answer));
}

/** The team and transfer-target lists the dialog loaded: the API removes only what was seen and unticked. */
export interface QueueBaseline {
  teamIds: string[];
  transferTargetIds: string[];
}

/** Transfer targets with the agent that would take the conversation over (PM/research/11 §5.5 transfer dialog). */
export interface TransferQueue {
  id: string;
  name: string;
  /** The receiving queue's AI agent; null when it has none (the conversation keeps its agent). */
  agentId: string | null;
  agentName: string | null;
}

export async function loadTransferQueues(): Promise<TransferQueue[]> {
  const [queues, agents] = await Promise.all([listQueues(), api.get('/v1/agents', z.array(z.object({ id: z.string(), name: z.string() }))).catch(() => [])]);
  const names = new Map(agents.map((a) => [a.id, a.name]));
  // Only approved queues take customers (the API refuses the rest with queue_not_approved).
  return queues.filter((q) => q.approval.approved).map((q) => ({ id: q.id, name: q.name, agentId: q.agentId, agentName: q.agentId ? (names.get(q.agentId) ?? 'another AI agent') : null }));
}

/* ───────────── Home (design/06 lead Queues table) ───────────── */

export interface QueueSummary {
  id: string;
  name: string;
  waiting: number;
  onShift: number;
  capacity: number;
  avgWaitSeconds: number;
  breaches: number;
  state: 'ok' | 'watch' | 'understaffed';
}

/**
 * Kept for the home screen, which renders this shape. The live data now
 * exists (GET /v1/analytics/queues → lib/api/analytics loadQueueAnalytics,
 * with avgWaitSeconds nullable); the home owner can switch to it.
 */
export function loadQueueSummaries(): Promise<QueueSummary[] | null> {
  return notYetAvailable('GET /v1/queues?include=live');
}
