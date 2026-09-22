import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { id, ts } from './columns.js';

/**
 * Immutable record of privileged actions (docs/15 §7). UPDATE/DELETE are
 * rejected by a trigger (migration 0001_audit_guards.sql).
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
    actorType: text().$type<'USER' | 'SYSTEM' | 'AGENT'>().notNull(),
    actorId: text(),
    actorName: text(),
    via: text().$type<'UI' | 'API' | 'INTERNAL_AGENT' | 'SYSTEM'>().notNull(),
    action: text().notNull(),
    targetType: text().notNull(),
    targetId: text(),
    summary: text().notNull(),
    before: jsonb(),
    after: jsonb(),
    correlationId: text(),
    confirmation: jsonb(),
    ip: text(),
  },
  (t) => [
    index('audit_events_time_idx').on(t.occurredAt),
    index('audit_events_target_idx').on(t.targetType, t.targetId),
    index('audit_events_actor_idx').on(t.actorId, t.occurredAt),
  ],
);

/** Transactional outbox for domain events (ADR-009). */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid().primaryKey(),
    type: text().notNull(),
    version: integer().notNull().default(1),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
    correlationId: text().notNull(),
    conversationId: uuid(),
    agentId: uuid(),
    payload: jsonb().notNull(),
    publishedAt: ts('published_at'),
  },
  (t) => [
    index('outbox_unpublished_idx').on(t.occurredAt).where(sql`${t.publishedAt} IS NULL`),
    index('outbox_conversation_idx').on(t.conversationId, t.occurredAt),
  ],
);
