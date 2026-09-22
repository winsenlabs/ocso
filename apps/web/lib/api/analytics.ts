import 'server-only';
import { z } from 'zod';
import { api } from './client';

/**
 * CS Lead business analytics (apps/api analytics.controller.ts, packages/
 * application/src/analytics/*). Every metric carries its formula in
 * `definition(s)`; the UI shows it next to the number (docs/11 §3).
 */

export const ANALYTICS_WINDOWS = [1, 7, 30, 90] as const;
export type AnalyticsDays = (typeof ANALYTICS_WINDOWS)[number];

const n = z.number().nullable();
const Tile = z.object({ value: n, previous: n, definition: z.string() });
const CountTile = z.object({ value: z.number(), previous: z.number(), definition: z.string() });
const Csat = z.object({ average: n, responses: z.number() });
const LabelCount = z.object({ key: z.string(), label: z.string(), count: z.number() });

export const OverviewSchema = z.object({
  window: z.object({ from: z.string(), to: z.string(), days: z.number(), timezone: z.string() }),
  tiles: z.object({
    conversations: CountTile,
    containmentRate: Tile,
    escalationRate: Tile,
    resolutionRate: Tile,
    firstResponseAiMedianSeconds: Tile,
    slaBreaches: CountTile,
    toolFailureRate: Tile,
    csat: z.object({ value: Csat, previous: Csat, definition: z.string() }),
  }),
  series: z.object({
    days: z.number(),
    points: z.array(z.object({ day: z.string(), conversations: z.number(), escalated: z.number(), containmentRate: n, escalationRate: n })),
    promptVersions: z.array(z.object({ agentName: z.string(), version: z.number(), activatedAt: z.string() })),
    definition: z.string(),
  }),
  escalationReasons: z.object({
    total: z.number(),
    reasons: z.array(z.object({ reasonCode: z.string(), trigger: z.string(), count: z.number(), example: z.string().nullable() })),
    definition: z.string(),
  }),
  failureTopics: z.object({ items: z.array(LabelCount), definition: z.string() }),
  knowledgeGaps: z.object({ items: z.array(LabelCount.extend({ isNew: z.boolean() })), newCount: z.number(), definition: z.string() }),
  channels: z.object({
    items: z.array(z.object({ channelId: z.string().nullable(), kind: z.string().nullable(), name: z.string().nullable(), conversations: z.number(), containmentRate: n, csat: n, csatResponses: z.number() })),
    definition: z.string(),
  }),
  handlingTime: z.object({
    buckets: z.array(z.object({ bucket: z.string(), ai: z.number(), human: z.number(), total: z.number() })),
    aiMedianSeconds: n,
    humanMedianSeconds: n,
    definition: z.string(),
  }),
  timeToResolution: z.object({ medianSeconds: n, definition: z.string() }),
  reopenRate: z.object({ value: n, reopened: z.number(), resolvedEver: z.number(), definition: z.string() }),
  costPerConversation: z.object({ valueMicros: n, currency: z.string().nullable(), cachedInputShare: n, definition: z.string() }),
});
export type Overview = z.infer<typeof OverviewSchema>;

export const AgentComparisonSchema = z.object({
  window: z.object({ from: z.string(), to: z.string(), days: z.number() }),
  agents: z.array(
    z.object({
      agentId: z.string(),
      name: z.string(),
      conversationType: z.string(),
      status: z.string(),
      conversations: z.number(),
      containmentRate: n,
      escalated: z.number(),
      escalationRate: n,
      resolutionRate: n,
      slaBreaches: z.number(),
      firstResponseAiMedianSeconds: n,
      csat: n,
      csatResponses: z.number(),
      toolFailureRate: n,
      costPerConversationMicros: n,
      currency: z.string().nullable(),
      topEscalationReason: z.string().nullable(),
    }),
  ),
  escalationRanking: z.array(z.object({ agentId: z.string(), name: z.string(), escalated: z.number(), escalationRate: n, conversations: z.number(), topEscalationReason: z.string().nullable() })),
  definitions: z.record(z.string(), z.string()),
});
export type AgentComparison = z.infer<typeof AgentComparisonSchema>;
export type AgentComparisonRow = AgentComparison['agents'][number];

export const QueueAnalyticsSchema = z.object({
  window: z.object({ from: z.string(), to: z.string(), days: z.number() }),
  queues: z.array(
    z.object({
      queueId: z.string(),
      name: z.string(),
      mode: z.string(),
      waiting: z.number(),
      oldestWaitingSince: z.string().nullable(),
      onShift: z.number(),
      members: z.number(),
      breaches: z.number(),
      slaBreachesInWindow: z.number(),
      avgWaitSeconds: n,
      pickedUp: z.number(),
      state: z.enum(['ok', 'watch', 'understaffed']),
    }),
  ),
  definitions: z.record(z.string(), z.string()),
});
export type QueueAnalytics = z.infer<typeof QueueAnalyticsSchema>;
export type QueueAnalyticsRow = QueueAnalytics['queues'][number];

const Split = z.object({ id: z.string().nullable(), name: z.string().nullable(), count: z.number() });
export const EscalationReasonsSchema = z.object({
  window: z.object({ from: z.string(), to: z.string(), days: z.number(), timezone: z.string() }),
  total: z.number(),
  previousTotal: z.number(),
  reasons: z.array(
    z.object({
      reasonCode: z.string(),
      trigger: z.string(),
      count: z.number(),
      previous: z.number(),
      example: z.string().nullable(),
      agents: z.array(Split),
      queues: z.array(Split),
    }),
  ),
  daily: z.array(z.object({ day: z.string(), total: z.number(), byReason: z.record(z.string(), z.number()) })),
  definitions: z.object({ reasons: z.string(), previous: z.string(), daily: z.string(), split: z.string() }),
});
export type EscalationReasons = z.infer<typeof EscalationReasonsSchema>;
export type EscalationReasonTrend = EscalationReasons['reasons'][number];

const q = (days: number) => `?days=${encodeURIComponent(String(days))}`;

export function loadOverview(days: number): Promise<Overview> {
  return api.get(`/v1/analytics/overview${q(days)}`, OverviewSchema);
}

export function loadAgentComparison(days: number): Promise<AgentComparison> {
  return api.get(`/v1/analytics/agents${q(days)}`, AgentComparisonSchema);
}

export function loadQueueAnalytics(days: number): Promise<QueueAnalytics> {
  return api.get(`/v1/analytics/queues${q(days)}`, QueueAnalyticsSchema);
}

export function loadEscalationReasonsReport(days: number): Promise<EscalationReasons> {
  return api.get(`/v1/analytics/escalation-reasons${q(days)}`, EscalationReasonsSchema);
}
