import 'server-only';
import { z } from 'zod';
import { api } from './client';
import { notYetAvailable } from './pending';

/* ───────────── Queues and SLA policies (apps/api routing.controller.ts, packages/application routing/queues.ts) ───────────── */

export const QUEUE_MODES = ['OPEN_PICKUP', 'AUTO_ASSIGN'] as const;
export type QueueMode = (typeof QUEUE_MODES)[number];
export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type Priority = (typeof PRIORITIES)[number];

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
}

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

export function updateQueue(id: string, patch: Partial<QueueRequest>): Promise<void> {
  return api.command('PATCH', `/v1/queues/${encodeURIComponent(id)}`, patch);
}

export async function saveSlaPolicy(id: string | null, input: SlaPolicyRequest): Promise<string> {
  const res = id ? await api.put(`/v1/sla-policies/${encodeURIComponent(id)}`, input, Created) : await api.post('/v1/sla-policies', input, Created);
  return res.id;
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
