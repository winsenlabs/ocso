import 'server-only';
import { z } from 'zod';
import { api } from './client';

/**
 * Tech Admin telemetry (GET /v1/telemetry/*, packages/application/src/telemetry).
 * Technical telemetry only — ids, counts, timings, tokens; never conversation
 * content. Every figure the API cannot compute is `null` and renders as "—".
 */

const n = z.number();
const nn = z.number().nullable();
const Defs = z.record(z.string(), z.string()).default({});

export const SERVICE_STATUSES = ['ok', 'degraded', 'down', 'unknown'] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

const ServiceChip = z.object({ key: z.string(), label: z.string(), status: z.enum(SERVICE_STATUSES), detail: z.string(), rule: z.string() });
export type ServiceChip = z.infer<typeof ServiceChip>;

const TopicDepth = z.object({ topic: z.string(), depth: n, inFlight: n, dead: n, oldestAgeSeconds: nn });
export type TopicDepth = z.infer<typeof TopicDepth>;

export const QueueDepthSchema = z.object({
  topics: z.array(TopicDepth),
  depth: n,
  inFlight: n,
  dead: n,
  oldestAgeSeconds: nn,
  turn: TopicDepth,
  source: z.enum(['adapter', 'jobs_table']),
});
export type QueueDepth = z.infer<typeof QueueDepthSchema>;

export const UptimeSchema = z.object({
  windowDays: n,
  minutes: n,
  upMinutes: n,
  ratio: nn,
  lastIncidentAt: z.string().nullable(),
  workerSamplesAvailable: z.boolean(),
  definition: z.string(),
});
export type Uptime = z.infer<typeof UptimeSchema>;

const OverviewSchema = z.object({
  generatedAt: z.string(),
  status: z.object({ overall: z.enum(SERVICE_STATUSES), headline: z.string(), healthy: n, degraded: n, chips: z.array(ServiceChip) }),
  uptime: UptimeSchema,
  tiles: z.object({
    windowMinutes: n,
    activeConversations: n,
    healthyWorkers: z.object({ healthy: n, max: n, minWarm: n }),
    queue: z.object({ depth: n, oldestAgeSeconds: nn, turnDepth: n, turnOldestAgeSeconds: nn }),
    turnLatencyP95Ms: nn,
    ttftP95Ms: nn,
    requestsPerMinute: n,
    tokensToday: n,
    cachedInputShareToday: nn,
    providerErrorRate: nn,
    worstToolFailure: z.object({ toolName: z.string(), connectionName: z.string().nullable(), finished: n, failed: n, failureRate: n }).nullable(),
    definitions: Defs,
  }),
  queue: QueueDepthSchema,
  traceUrlTemplate: z.string().nullable(),
});
export type TelemetryOverview = z.infer<typeof OverviewSchema>;

/** Percentiles computed once over the whole window (not averaged from minutes). */
const LatencyWindowSchema = z.object({ turns: n, turnP50Ms: nn, turnP95Ms: nn, ttftRequests: n, ttftP50Ms: nn, ttftP95Ms: nn });
export type LatencyWindow = z.infer<typeof LatencyWindowSchema>;

const LatencySchema = z.object({
  minutes: n,
  window: LatencyWindowSchema,
  points: z.array(z.object({ minute: z.string(), turnP50Ms: nn, turnP95Ms: nn, ttftP50Ms: nn, ttftP95Ms: nn, turns: n, requests: n, errors: n, fallbacks: n })),
  markers: z.array(
    z.object({
      minute: z.string(),
      kind: z.enum(['fallback', 'provider_errors']),
      providerId: z.string().nullable(),
      providerName: z.string().nullable(),
      count: n,
      errorCategory: z.string().nullable(),
    }),
  ),
  slowestTurns: z.array(
    z.object({ turnId: z.string(), latencyMs: nn, ttftMs: nn, model: z.string().nullable(), traceId: z.string().nullable(), traceUrl: z.string().nullable(), startedAt: z.string() }),
  ),
  traceUrlTemplate: z.string().nullable(),
  definitions: Defs,
});
export type LatencySeries = z.infer<typeof LatencySchema>;

const Totals = z.object({
  requests: n,
  inputTokens: n,
  outputTokens: n,
  cacheReadTokens: nn,
  cacheWriteTokens: nn,
  reasoningTokens: nn,
  cachedInputShare: nn,
  costMicros: nn,
  currency: z.string().nullable(),
});
export type TokenTotals = z.infer<typeof Totals>;

const PurposeUsageSchema = Totals.extend({ purpose: z.string(), tokenShare: nn });
export type PurposeUsage = z.infer<typeof PurposeUsageSchema>;

const UsageSchema = z.object({
  from: z.string(),
  to: z.string(),
  totals: Totals,
  byProfile: z.array(Totals.extend({ profileId: z.string().nullable(), profileName: z.string().nullable(), tokenShare: nn })),
  /** usage_events grouped by purpose (TURN, SUMMARY, COPILOT, INTERNAL_AGENT, CLASSIFIER, EVALUATION, TEST). */
  byPurpose: z.array(PurposeUsageSchema),
  definitions: Defs,
});
export type TokenUsage = z.infer<typeof UsageSchema>;

export const WorkerViewSchema = z.object({
  id: z.string(),
  hostname: z.string(),
  version: z.string(),
  status: z.string(),
  effectiveStatus: z.string(),
  capacity: n,
  activeLeases: n,
  busyTurns: n,
  utilization: nn,
  cpuPercent: nn,
  memoryMb: nn,
  platformRef: z.string().nullable(),
  startedAt: z.string(),
  uptimeSeconds: n,
  heartbeatAt: z.string(),
  heartbeatAgeSeconds: n,
});
export type WorkerView = z.infer<typeof WorkerViewSchema>;

const WorkersSchema = z.object({
  workers: z.array(WorkerViewSchema),
  healthy: n,
  leases: z.object({
    active: n,
    busy: n,
    slotsTotal: n,
    recoveredToday: n,
    leaseDurationSeconds: n,
    heartbeatIntervalSeconds: n,
    definitions: Defs,
  }),
  config: z.object({
    minWarmWorkers: n,
    maxWorkers: n,
    conversationsPerWorker: n,
    targetUtilization: n,
    scaleOutQueueAgeSeconds: n,
    scaleOutQueueDepth: n,
    scaleInCooldownSeconds: n,
    turnTimeoutSeconds: n,
    leaseDurationSeconds: n,
    heartbeatIntervalSeconds: n,
    autoscalingEnabled: z.boolean(),
    lastChange: z.object({ at: z.string(), actorName: z.string().nullable(), summary: z.string() }).nullable(),
  }),
  definition: z.string(),
});
export type WorkersTelemetry = z.infer<typeof WorkersSchema>;

export const ProviderHealthSchema = z.object({
  providerId: z.string(),
  kind: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  status: z.string(),
  region: z.string().nullable(),
  residencyZone: z.string().nullable(),
  lastHealthAt: z.string().nullable(),
  lastHealthLatencyMs: nn,
  lastError: z.string().nullable(),
  requests1h: n,
  p95LatencyMs: nn,
  errorRate: nn,
  fallbacksFrom1h: n,
  tokensToday: n,
  cacheReadShare: nn,
  costTodayMicros: nn,
  currency: z.string().nullable(),
  profiles: z.array(z.object({ id: z.string(), name: z.string(), role: z.enum(['PRIMARY', 'FALLBACK']), cachePolicy: z.string() })),
  cacheSupport: z.enum(['REPORTED', 'NOT_REPORTED', 'NO_TRAFFIC']),
});
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;

export const McpHealthSchema = z.object({
  connectionId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  server: z.string(),
  network: z.string(),
  authStrategy: z.string(),
  scope: z.string(),
  status: z.string(),
  approved: z.boolean(),
  tools: n,
  toolsDiscovered: n,
  calls24h: n,
  failureRate24h: nn,
  p95LatencyMs: nn,
  lastHealthStatus: z.string().nullable(),
  lastHealthLatencyMs: nn,
  lastHealthAt: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type McpHealth = z.infer<typeof McpHealthSchema>;

const McpSchema = z.object({ connections: z.array(McpHealthSchema), personalConnections: n, definitions: Defs });
export type McpTelemetry = z.infer<typeof McpSchema>;

export const PrivilegedChangeSchema = z.object({
  id: z.string(),
  occurredAt: z.string(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  summary: z.string(),
  actorType: z.string(),
  actorId: z.string().nullable(),
  actorName: z.string().nullable(),
  via: z.string(),
  correlationId: z.string().nullable(),
});
export type PrivilegedChange = z.infer<typeof PrivilegedChangeSchema>;

export const loadTelemetryOverview = () => api.get('/v1/telemetry/overview', OverviewSchema);
export const loadLatency = (minutes = 60) => api.get(`/v1/telemetry/latency?minutes=${minutes}`, LatencySchema);
export const loadUsage = () => api.get('/v1/telemetry/usage', UsageSchema);
export const loadWorkersTelemetry = () => api.get('/v1/telemetry/workers', WorkersSchema);
export const loadProviderHealth = async () => (await api.get('/v1/telemetry/providers', z.object({ providers: z.array(ProviderHealthSchema) }))).providers;
export const loadMcpHealth = () => api.get('/v1/telemetry/mcp', McpSchema);
export const loadPrivilegedChanges = async (limit = 20) =>
  (await api.get(`/v1/telemetry/changes?limit=${limit}`, z.object({ changes: z.array(PrivilegedChangeSchema) }))).changes;
