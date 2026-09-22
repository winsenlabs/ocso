import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './columns.js';
import { users } from './identity.js';

/** Pluggable delivery targets (docs/11 §7). Secrets by reference. */
export const notificationDestinations = pgTable('notification_destinations', {
  id: id(),
  name: text().notNull(),
  kind: text().$type<'IN_APP' | 'EMAIL' | 'SLACK' | 'TEAMS' | 'WEBHOOK' | 'PAGERDUTY'>().notNull(),
  config: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  secretRef: text(),
  enabled: boolean().notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Alert rule: condition + window + severity + audience + delivery (build rule §16). */
export const alertRules = pgTable(
  'alert_rules',
  {
    id: id(),
    name: text().notNull(),
    kind: text().$type<'TECHNICAL' | 'BUSINESS'>().notNull(),
    condition: text().notNull(),
    params: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** null = platform-wide. */
    agentId: uuid(),
    windowSeconds: integer().notNull().default(300),
    severity: text().$type<'INFO' | 'WARNING' | 'CRITICAL'>().notNull().default('WARNING'),
    audienceRoles: text().array().notNull(),
    destinationIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    dedupeWindowSeconds: integer().notNull().default(3600),
    autoResolve: boolean().notNull().default(true),
    enabled: boolean().notNull().default(true),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('alert_rules_enabled_idx').on(t.enabled, t.kind)],
);

export const alerts = pgTable(
  'alerts',
  {
    id: id(),
    ruleId: uuid().references(() => alertRules.id, { onDelete: 'set null' }),
    fingerprint: text().notNull(),
    kind: text().$type<'TECHNICAL' | 'BUSINESS'>().notNull(),
    severity: text().$type<'INFO' | 'WARNING' | 'CRITICAL'>().notNull(),
    status: text().$type<'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED'>().notNull().default('OPEN'),
    title: text().notNull(),
    body: text().notNull(),
    audienceRoles: text().array().notNull(),
    source: text().notNull(),
    context: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    value: text(),
    occurrences: integer().notNull().default(1),
    openedAt: ts('opened_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    acknowledgedAt: ts('acknowledged_at'),
    acknowledgedBy: uuid(),
    resolvedAt: ts('resolved_at'),
    resolvedBy: uuid(),
    resolution: text(),
  },
  (t) => [
    // Deduplication: at most one unresolved alert per fingerprint.
    uniqueIndex('alerts_open_fingerprint_uq').on(t.fingerprint).where(sql`${t.status} <> 'RESOLVED'`),
    index('alerts_status_idx').on(t.status, t.openedAt),
  ],
);

export const alertDeliveries = pgTable(
  'alert_deliveries',
  {
    id: id(),
    alertId: uuid()
      .notNull()
      .references(() => alerts.id, { onDelete: 'cascade' }),
    destinationId: uuid().notNull(),
    event: text().$type<'OPENED' | 'ACKNOWLEDGED' | 'RESOLVED' | 'REMINDER'>().notNull(),
    status: text().$type<'PENDING' | 'SENT' | 'FAILED'>().notNull().default('PENDING'),
    attempts: integer().notNull().default(0),
    lastError: text(),
    createdAt: createdAt(),
    sentAt: ts('sent_at'),
  },
  (t) => [index('alert_deliveries_alert_idx').on(t.alertId)],
);

/** Outbound event webhooks (design/04 Webhooks tab). */
export const webhookSubscriptions = pgTable('webhook_subscriptions', {
  id: id(),
  name: text().notNull(),
  url: text().notNull(),
  events: text().array().notNull(),
  signingSecretRef: text().notNull(),
  enabled: boolean().notNull().default(true),
  createdBy: uuid(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: id(),
    subscriptionId: uuid()
      .notNull()
      .references(() => webhookSubscriptions.id, { onDelete: 'cascade' }),
    eventId: uuid().notNull(),
    eventType: text().notNull(),
    status: text().$type<'PENDING' | 'SENT' | 'FAILED'>().notNull().default('PENDING'),
    attempts: integer().notNull().default(0),
    responseStatus: integer(),
    lastError: text(),
    createdAt: createdAt(),
    sentAt: ts('sent_at'),
  },
  (t) => [
    index('webhook_deliveries_sub_idx').on(t.subscriptionId, t.createdAt),
    // One delivery per event per subscription: the relay can re-run safely.
    uniqueIndex('webhook_deliveries_event_uq').on(t.subscriptionId, t.eventId),
  ],
);
