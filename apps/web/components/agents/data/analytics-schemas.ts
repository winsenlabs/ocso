import { z } from 'zod';

/**
 * CS Lead analytics contracts (GET /v1/analytics/agents/:id and
 * /v1/analytics/agents, packages/application/src/analytics). Every metric
 * carries its formula as `definition`; the UI surfaces it next to the number.
 */

const n = z.number().nullable();
const tile = <T extends z.ZodType>(value: T) => z.object({ value, previous: value, definition: z.string() });
const LabelCount = z.object({ key: z.string(), label: z.string(), count: z.number() });
export type LabelCount = z.infer<typeof LabelCount>;

const CsatStat = z.object({ average: n, responses: z.number(), aiHandledAverage: n, humanHandledAverage: n });
export type CsatStat = z.infer<typeof CsatStat>;

export const DailyPointSchema = z.object({ day: z.string(), conversations: z.number(), contained: z.number(), escalated: z.number(), containmentRate: n, escalationRate: n });
export type DailyPoint = z.infer<typeof DailyPointSchema>;
export const VersionMarkerSchema = z.object({ versionId: z.string(), version: z.number(), reason: z.string(), activatedAt: z.string(), actorName: z.string().nullable() });
export type VersionMarker = z.infer<typeof VersionMarkerSchema>;

export const ReviewedConversationSchema = z.object({
  reviewId: z.string(),
  conversationId: z.string(),
  displayId: z.string(),
  customerName: z.string().nullable(),
  channelKind: z.string().nullable(),
  topic: z.string().nullable(),
  reviewerName: z.string(),
  outcomeTag: z.string(),
  controlState: z.string(),
  score: z.number(),
  rubric: z.record(z.string(), z.number()),
  reviewedAt: z.string(),
});
export type ReviewedConversation = z.infer<typeof ReviewedConversationSchema>;

export const CorrectionOpportunitySchema = z.object({
  id: z.string(),
  title: z.string(),
  observed: z.string(),
  desired: z.string(),
  componentKey: z.string(),
  status: z.enum(['OPEN', 'STAGED']),
  source: z.string(),
  occurrences: z.number(),
  conversationId: z.string().nullable(),
  createdAt: z.string(),
});
export type CorrectionOpportunity = z.infer<typeof CorrectionOpportunitySchema>;

export const ChannelBreakdownSchema = z.object({
  channelId: z.string().nullable(),
  kind: z.string().nullable(),
  name: z.string().nullable(),
  conversations: z.number(),
  contained: z.number(),
  containmentRate: n,
  csat: n,
  csatResponses: z.number(),
});
export type ChannelBreakdown = z.infer<typeof ChannelBreakdownSchema>;

export const AgentAnalyticsSchema = z.object({
  window: z.object({ from: z.string(), to: z.string(), days: z.number(), timezone: z.string() }),
  tiles: z.object({
    conversations: tile(z.number()),
    containmentRate: tile(n),
    escalationRate: tile(n),
    resolutionRate: tile(n),
    firstResponseAiMedianSeconds: tile(n),
    slaBreaches: tile(z.number()),
    toolFailureRate: tile(n),
    csat: tile(CsatStat),
  }),
  series: z.object({ days: z.number(), points: z.array(DailyPointSchema), promptVersions: z.array(VersionMarkerSchema), definition: z.string() }),
  escalationReasons: z.object({
    total: z.number(),
    reasons: z.array(z.object({ reasonCode: z.string(), trigger: z.string(), count: z.number(), example: z.string().nullable() })),
    definition: z.string(),
  }),
  failureTopics: z.object({ items: z.array(LabelCount), definition: z.string() }),
  topics: z.object({ items: z.array(LabelCount), definition: z.string() }),
  knowledgeGaps: z.object({ items: z.array(LabelCount.extend({ firstSeenAt: z.string(), isNew: z.boolean() })), newCount: z.number(), definition: z.string() }),
  outcomes: z.object({ analyzed: z.number(), outcomes: z.record(z.string(), z.number()), sentiments: z.record(z.string(), z.number()), coverage: n, definition: z.string() }),
  corrections: z.object({ open: z.number(), staged: z.number(), items: z.array(CorrectionOpportunitySchema), insightCandidates: z.array(LabelCount), definition: z.string() }),
  reviews: z.object({ inWindow: z.number(), items: z.array(ReviewedConversationSchema) }),
  channels: z.object({ items: z.array(ChannelBreakdownSchema), definition: z.string() }),
  handlingTime: z.object({
    buckets: z.array(z.object({ bucket: z.string(), ai: z.number(), human: z.number(), total: z.number() })),
    aiMedianSeconds: n,
    humanMedianSeconds: n,
    definition: z.string(),
  }),
  timeToResolution: z.object({ medianSeconds: n, definition: z.string() }),
  reopenRate: z.object({ value: n, reopened: z.number(), resolvedEver: z.number(), definition: z.string() }),
  costPerConversation: z.object({
    valueMicros: n,
    costMicros: n,
    currency: z.string().nullable(),
    conversations: z.number(),
    cachedInputShare: n,
    definition: z.string(),
  }),
  salesOutcomes: z.object({ items: z.array(z.object({ outcome: z.string(), count: z.number() })), definition: z.string() }).nullable(),
});
export type AgentAnalytics = z.infer<typeof AgentAnalyticsSchema>;

export const ComparisonRowSchema = z.object({
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
});
export type ComparisonRow = z.infer<typeof ComparisonRowSchema>;

export const ComparisonSchema = z.object({
  window: z.object({ from: z.string(), to: z.string(), days: z.number() }),
  agents: z.array(ComparisonRowSchema),
  definitions: z.record(z.string(), z.string()),
});
export type AgentComparison = z.infer<typeof ComparisonSchema>;
