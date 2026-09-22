import type { AlertDeliveryAdapter, AlertKind, AlertSeverity, AlertStatus } from '@ocso/alerts';
import type { alertDeliveries, alertRules, alerts, notificationDestinations } from '@ocso/db';

export type AlertRow = typeof alerts.$inferSelect;
export type AlertRuleRow = typeof alertRules.$inferSelect;
export type AlertDeliveryRow = typeof alertDeliveries.$inferSelect;
export type NotificationDestinationRow = typeof notificationDestinations.$inferSelect;

export interface AlertView {
  id: string;
  ruleId: string | null;
  ruleName: string | null;
  condition: string | null;
  fingerprint: string;
  kind: AlertKind;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  body: string;
  value: string | null;
  source: string;
  audienceRoles: string[];
  /** Virtual agent the alert concerns, when agent-specific. */
  agentId: string | null;
  context: Record<string, unknown>;
  occurrences: number;
  openedAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolution: string | null;
}

export interface AlertDeliveryView {
  id: string;
  destinationId: string;
  destinationName: string | null;
  destinationKind: string | null;
  event: AlertDeliveryRow['event'];
  status: AlertDeliveryRow['status'];
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface AlertDetailView extends AlertView {
  deliveries: AlertDeliveryView[];
}

export interface AlertRuleView {
  id: string;
  name: string;
  kind: AlertKind;
  condition: string;
  conditionLabel: string | null;
  params: Record<string, unknown>;
  agentId: string | null;
  windowSeconds: number;
  severity: AlertSeverity;
  audienceRoles: string[];
  destinationIds: string[];
  dedupeWindowSeconds: number;
  autoResolve: boolean;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationDestinationView {
  id: string;
  name: string;
  kind: NotificationDestinationRow['kind'];
  /**
   * Non-secret configuration as the adapter normalizes it (defaults applied,
   * legacy shapes upgraded); null for viewers who cannot manage destinations.
   */
  config: Record<string, unknown> | null;
  /** The adapter's one-line description of the config; null without config access or when invalid. */
  summary: string | null;
  /** Whether a secret is stored — the value itself is never returned. */
  hasSecret: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

export function toAlertView(row: AlertRow, rule?: { name: string | null; condition: string | null } | null): AlertView {
  const agentId = typeof row.context['agentId'] === 'string' ? row.context['agentId'] : null;
  return {
    id: row.id,
    ruleId: row.ruleId,
    ruleName: rule?.name ?? null,
    condition: rule?.condition ?? null,
    fingerprint: row.fingerprint,
    kind: row.kind,
    severity: row.severity,
    status: row.status,
    title: row.title,
    body: row.body,
    value: row.value,
    source: row.source,
    audienceRoles: row.audienceRoles,
    agentId,
    context: row.context,
    occurrences: row.occurrences,
    openedAt: row.openedAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    acknowledgedAt: iso(row.acknowledgedAt),
    acknowledgedBy: row.acknowledgedBy,
    resolvedAt: iso(row.resolvedAt),
    resolvedBy: row.resolvedBy,
    resolution: row.resolution,
  };
}

export function toRuleView(row: AlertRuleRow, conditionLabel: string | null): AlertRuleView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    condition: row.condition,
    conditionLabel,
    params: row.params,
    agentId: row.agentId,
    windowSeconds: row.windowSeconds,
    severity: row.severity,
    audienceRoles: row.audienceRoles,
    destinationIds: row.destinationIds,
    dedupeWindowSeconds: row.dedupeWindowSeconds,
    autoResolve: row.autoResolve,
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toDestinationView(row: NotificationDestinationRow, includeConfig: boolean, adapter: AlertDeliveryAdapter | undefined): NotificationDestinationView {
  const check = includeConfig && adapter ? adapter.validateConfig(row.config) : null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    config: includeConfig ? (check?.ok ? (check.config as Record<string, unknown>) : row.config) : null,
    summary: check?.ok && adapter ? adapter.summary(check.config) : null,
    hasSecret: row.secretRef !== null,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
