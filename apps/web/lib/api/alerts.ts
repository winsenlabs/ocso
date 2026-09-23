import 'server-only';
import { z } from 'zod';
import { api } from './client';

/**
 * Alerts (docs/11 §6–7; apps/api/src/modules/alerts). A user sees an alert only
 * when their role is in its audience AND they may read its kind — the API
 * scopes every list, so the UI never filters for security.
 */

export const ALERT_KINDS = ['TECHNICAL', 'BUSINESS'] as const;
export const ALERT_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;
export const ALERT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] as const;
export const AUDIENCE_ROLES = ['TECH', 'HEAD', 'LEAD', 'SERVICE'] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];
export type AlertStatus = (typeof ALERT_STATUSES)[number];
export type AudienceRole = (typeof AUDIENCE_ROLES)[number];

export const AlertSchema = z.object({
  id: z.string(),
  ruleId: z.string().nullable(),
  ruleName: z.string().nullable(),
  condition: z.string().nullable(),
  fingerprint: z.string(),
  kind: z.enum(ALERT_KINDS),
  severity: z.enum(ALERT_SEVERITIES),
  status: z.enum(ALERT_STATUSES),
  title: z.string(),
  body: z.string(),
  value: z.string().nullable(),
  source: z.string(),
  audienceRoles: z.array(z.string()),
  agentId: z.string().nullable(),
  context: z.record(z.string(), z.unknown()),
  occurrences: z.number(),
  openedAt: z.string(),
  lastSeenAt: z.string(),
  acknowledgedAt: z.string().nullable(),
  acknowledgedBy: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  resolution: z.string().nullable(),
});
export type Alert = z.infer<typeof AlertSchema>;

export const DeliverySchema = z.object({
  id: z.string(),
  destinationId: z.string(),
  destinationName: z.string().nullable(),
  destinationKind: z.string().nullable(),
  event: z.string(),
  status: z.string(),
  attempts: z.number(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
});
export type AlertDelivery = z.infer<typeof DeliverySchema>;

const AlertDetailSchema = AlertSchema.extend({ deliveries: z.array(DeliverySchema) });
export type AlertDetail = z.infer<typeof AlertDetailSchema>;

const PageSchema = z.object({ items: z.array(AlertSchema), nextCursor: z.string().nullable() });
export type AlertPage = z.infer<typeof PageSchema>;

const CountsSchema = z.object({
  unresolved: z.number(),
  open: z.number(),
  acknowledged: z.number(),
  bySeverity: z.record(z.string(), z.number()),
  byKind: z.record(z.string(), z.number()),
});
export type AlertCounts = z.infer<typeof CountsSchema>;

export const RuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(ALERT_KINDS),
  condition: z.string(),
  conditionLabel: z.string().nullable(),
  params: z.record(z.string(), z.unknown()),
  agentId: z.string().nullable(),
  windowSeconds: z.number(),
  severity: z.enum(ALERT_SEVERITIES),
  audienceRoles: z.array(z.string()),
  destinationIds: z.array(z.string()),
  dedupeWindowSeconds: z.number(),
  autoResolve: z.boolean(),
  enabled: z.boolean(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AlertRule = z.infer<typeof RuleSchema>;

export const ConditionSchema = z.object({
  condition: z.string(),
  label: z.string(),
  kinds: z.array(z.enum(ALERT_KINDS)),
  agentScoped: z.boolean(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()),
});
export type AlertCondition = z.infer<typeof ConditionSchema>;

export const DestinationSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  config: z.record(z.string(), z.unknown()).nullable(),
  /** The adapter's one-line description of the config (managers only). */
  summary: z.string().nullable().default(null),
  hasSecret: z.boolean(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type NotificationDestination = z.infer<typeof DestinationSchema>;

/**
 * A destination kind as its delivery adapter describes itself
 * (GET /v1/notification-destinations/kinds). Kinds are open strings: the
 * form renders from `configSchema`, never from a list of known kinds.
 */
export const DestinationKindSchema = z.object({
  kind: z.string(),
  label: z.string(),
  description: z.string(),
  events: z.array(z.string()),
  configSchema: z.record(z.string(), z.unknown()),
  secret: z
    .object({ label: z.string(), description: z.string(), required: z.boolean(), when: z.record(z.string(), z.string()).nullable() })
    .nullable(),
});
export type DestinationKindInfo = z.infer<typeof DestinationKindSchema>;

const TestResultSchema = z.object({ ok: z.boolean(), retriable: z.boolean(), error: z.string().optional() });
export type DestinationTestResult = z.infer<typeof TestResultSchema>;

export interface AlertListFilter {
  status?: AlertStatus | 'UNRESOLVED' | undefined;
  kind?: AlertKind | undefined;
  severity?: AlertSeverity | undefined;
  agentId?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface AlertRuleInput {
  name: string;
  kind: AlertKind;
  condition: string;
  params: Record<string, unknown>;
  windowSeconds: number;
  severity: AlertSeverity;
  audienceRoles: AudienceRole[];
  destinationIds: string[];
  dedupeWindowSeconds: number;
  autoResolve: boolean;
  enabled: boolean;
}

export interface DestinationInput {
  name: string;
  kind: string;
  config: Record<string, unknown>;
  secret?: string | undefined;
  enabled: boolean;
}

function query(filter: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== '') params.set(key, String(value));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

const id = (value: string) => encodeURIComponent(value);

export const listAlerts = (filter: AlertListFilter = {}) => api.get(`/v1/alerts${query(filter)}`, PageSchema);
export const alertCounts = () => api.get('/v1/alerts/counts', CountsSchema);
export const getAlert = (alertId: string) => api.get(`/v1/alerts/${id(alertId)}`, AlertDetailSchema);
export const acknowledgeAlert = (alertId: string, note?: string) =>
  api.post(`/v1/alerts/${id(alertId)}/acknowledge`, note ? { note } : {}, AlertDetailSchema);
export const resolveAlert = (alertId: string, note: string) => api.post(`/v1/alerts/${id(alertId)}/resolve`, { note }, AlertDetailSchema);

export const listAlertRules = (kind?: AlertKind) => api.get(`/v1/alert-rules${query({ kind })}`, z.array(RuleSchema));
export const listAlertConditions = () => api.get('/v1/alert-rules/conditions', z.array(ConditionSchema));
export const createAlertRule = (input: AlertRuleInput) => api.post('/v1/alert-rules', input, RuleSchema);
export const updateAlertRule = (ruleId: string, patch: Partial<AlertRuleInput>) => api.patch(`/v1/alert-rules/${id(ruleId)}`, patch, RuleSchema);
export const deleteAlertRule = (ruleId: string) => api.command('DELETE', `/v1/alert-rules/${id(ruleId)}`);

export const listDestinations = () => api.get('/v1/notification-destinations', z.array(DestinationSchema));
export const listDestinationKinds = () => api.get('/v1/notification-destinations/kinds', z.array(DestinationKindSchema));
export const createDestination = (input: DestinationInput) => api.post('/v1/notification-destinations', input, DestinationSchema);
export const updateDestination = (destinationId: string, patch: Partial<Omit<DestinationInput, 'kind'>>) =>
  api.patch(`/v1/notification-destinations/${id(destinationId)}`, patch, DestinationSchema);
export const deleteDestination = (destinationId: string) => api.command('DELETE', `/v1/notification-destinations/${id(destinationId)}`);
/** Sends a synthetic alert through the destination right away (network call; allow for its timeout). */
export const testDestination = (destinationId: string) =>
  api.post(`/v1/notification-destinations/${id(destinationId)}/test`, undefined, TestResultSchema, { timeoutMs: 30_000 });
