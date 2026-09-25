import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts } from './columns.js';
import { conversations } from './conversations.js';
import { users } from './identity.js';
import { queues } from './routing.js';

/** Why/when human intervention was requested and how it progressed (docs/archive/specs/03 Handoff). */
export const handoffs = pgTable(
  'handoffs',
  {
    id: id(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    trigger: text().notNull(),
    reasonCode: text().notNull(),
    reasonText: text().notNull(),
    ruleId: uuid(),
    requestedByType: text().$type<'AGENT' | 'SYSTEM' | 'HUMAN' | 'CUSTOMER'>().notNull(),
    requestedById: text(),
    mode: text().$type<'AUTO_ASSIGN' | 'OPEN_PICKUP'>().notNull(),
    queueId: uuid().references(() => queues.id),
    priority: text().$type<'P1' | 'P2' | 'P3' | 'P4'>().notNull(),
    status: text()
      .$type<'REQUESTED' | 'WAITING' | 'OFFERED' | 'ACTIVE' | 'RETURNED' | 'RESOLVED' | 'CANCELLED'>()
      .notNull()
      .default('REQUESTED'),
    agentSummary: text(),
    handoverSummary: text(),
    assignedUserId: uuid().references(() => users.id),
    declinedUserIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    requestedAt: ts('requested_at').notNull().defaultNow(),
    routedAt: ts('routed_at'),
    offeredAt: ts('offered_at'),
    acceptedAt: ts('accepted_at'),
    returnedAt: ts('returned_at'),
    resolvedAt: ts('resolved_at'),
    cancelledAt: ts('cancelled_at'),
    autoAssignAt: ts('auto_assign_at'),
    offerExpiresAt: ts('offer_expires_at'),
  },
  (t) => [
    index('handoffs_conversation_idx').on(t.conversationId, t.requestedAt),
    index('handoffs_open_idx').on(t.status, t.queueId).where(sql`${t.status} IN ('REQUESTED','WAITING','OFFERED')`),
  ],
);

/** History of ownership transitions (docs/archive/specs/03 Assignment). */
export const assignments = pgTable(
  'assignments',
  {
    id: id(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    handoffId: uuid(),
    kind: text().$type<'AUTO' | 'CLAIM' | 'TAKE_OVER' | 'TRANSFER' | 'MANUAL' | 'REOPEN'>().notNull(),
    assignedBy: uuid(),
    assignedAt: ts('assigned_at').notNull().defaultNow(),
    acceptedAt: ts('accepted_at'),
    endedAt: ts('ended_at'),
    endReason: text(),
  },
  (t) => [
    index('assignments_conversation_idx').on(t.conversationId, t.assignedAt),
    index('assignments_user_open_idx').on(t.userId).where(sql`${t.endedAt} IS NULL`),
  ],
);

/** One agent execution for a conversation (docs/archive/specs/04 §3). */
export const turns = pgTable(
  'turns',
  {
    id: id(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    status: text()
      .$type<'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'SUPERSEDED'>()
      .notNull()
      .default('RUNNING'),
    outcome: text().$type<'REPLIED' | 'HANDOFF' | 'NO_REPLY' | 'FAILED' | 'CANCELLED' | 'AWAITING_CONFIRMATION' | 'TRANSFERRED'>(),
    /** The agent that ran the turn (a conversation changes agent on queue transfers). */
    agentId: uuid(),
    workerId: text().notNull(),
    leaseVersion: integer().notNull(),
    seqFrom: integer().notNull(),
    seqTo: integer().notNull(),
    promptVersionId: uuid(),
    modelProfileId: uuid(),
    providerId: uuid(),
    model: text(),
    steps: integer().notNull().default(0),
    cacheLayer: text().$type<'HOT' | 'SNAPSHOT' | 'COLD'>(),
    contextHashes: jsonb().$type<Record<string, string | null>>(),
    errorCategory: text(),
    errorMessage: text(),
    latencyMs: integer(),
    ttftMs: integer(),
    traceId: text(),
    startedAt: ts('started_at').notNull().defaultNow(),
    completedAt: ts('completed_at'),
    createdAt: createdAt(),
  },
  (t) => [index('turns_conversation_idx').on(t.conversationId, t.startedAt), index('turns_status_idx').on(t.status, t.startedAt)],
);
