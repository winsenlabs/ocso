import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, real, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './columns.js';
import { customers, channels } from './customers.js';
import { users } from './identity.js';
import { virtualAgents } from './agents.js';
import { queues } from './routing.js';

export const conversations = pgTable(
  'conversations',
  {
    id: id(),
    customerId: uuid()
      .notNull()
      .references(() => customers.id),
    agentId: uuid()
      .notNull()
      .references(() => virtualAgents.id),
    channelId: uuid().references(() => channels.id),
    type: text().notNull(),
    controlState: text().notNull().default('AI_ACTIVE'),
    businessStatus: text(),
    queueId: uuid().references(() => queues.id),
    assignedUserId: uuid().references(() => users.id),
    priority: text().$type<'P1' | 'P2' | 'P3' | 'P4'>().notNull().default('P3'),
    /** Optimistic concurrency for control transitions. */
    version: integer().notNull().default(1),
    lastSeq: integer().notNull().default(0),
    /** Highest customer interaction seq answered by a completed turn. */
    lastProcessedSeq: integer().notNull().default(0),
    lastCustomerMessageAt: ts('last_customer_message_at'),
    lastInteractionAt: ts('last_interaction_at').notNull().defaultNow(),
    lastPreview: text(),
    waitingSince: ts('waiting_since'),
    slaDueAt: ts('sla_due_at'),
    firstHumanResponseAt: ts('first_human_response_at'),
    summaryVersion: integer().notNull().default(0),
    disposition: text(),
    tags: text().array().notNull().default(sql`'{}'::text[]`),
    reopenCount: integer().notNull().default(0),
    csatScore: real(),
    openedAt: ts('opened_at').notNull().defaultNow(),
    resolvedAt: ts('resolved_at'),
    resolvedBy: uuid(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('conversations_state_idx').on(t.controlState, t.queueId, t.priority),
    index('conversations_customer_idx').on(t.customerId),
    index('conversations_assigned_idx').on(t.assignedUserId).where(sql`${t.controlState} <> 'RESOLVED'`),
    index('conversations_agent_idx').on(t.agentId, t.openedAt),
    index('conversations_recent_idx').on(t.lastInteractionAt),
    // At most one open conversation per customer, channel and agent.
    uniqueIndex('conversations_open_uq')
      .on(t.customerId, t.channelId, t.agentId)
      .where(sql`${t.controlState} <> 'RESOLVED'`),
  ],
);

/** One logical conversational event (docs/03 Interaction). Append-only. */
export const interactions = pgTable(
  'interactions',
  {
    id: id(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    channelId: uuid(),
    seq: integer().notNull(),
    actorType: text().$type<'CUSTOMER' | 'AGENT' | 'HUMAN' | 'SYSTEM' | 'TOOL'>().notNull(),
    actorId: text(),
    direction: text().$type<'INBOUND' | 'OUTBOUND' | 'INTERNAL'>().notNull(),
    visibility: text().$type<'CUSTOMER' | 'INTERNAL'>().notNull(),
    kind: text().$type<'MESSAGE' | 'SYSTEM_EVENT' | 'TOOL_EVENT'>().notNull().default('MESSAGE'),
    correlationId: text().notNull(),
    idempotencyKey: text(),
    deliveryStatus: text().notNull().default('NOT_APPLICABLE'),
    deliveryError: text(),
    externalMessageId: text(),
    turnId: uuid(),
    preview: text(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('interactions_seq_uq').on(t.conversationId, t.seq),
    uniqueIndex('interactions_idempotency_uq')
      .on(t.channelId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    index('interactions_external_idx').on(t.externalMessageId).where(sql`${t.externalMessageId} IS NOT NULL`),
    index('interactions_conversation_recent_idx').on(t.conversationId, t.seq),
  ],
);

/** Typed parts per interaction; media bytes live in BlobStore. */
export const interactionParts = pgTable(
  'interaction_parts',
  {
    id: id(),
    interactionId: uuid()
      .notNull()
      .references(() => interactions.id, { onDelete: 'cascade' }),
    idx: integer().notNull(),
    type: text().notNull(),
    content: jsonb().$type<Record<string, unknown>>().notNull(),
    blobKey: text(),
    mediaStatus: text(),
  },
  (t) => [
    uniqueIndex('interaction_parts_idx_uq').on(t.interactionId, t.idx),
    index('interaction_parts_media_idx').on(t.mediaStatus).where(sql`${t.mediaStatus} IS NOT NULL`),
  ],
);

/** Staff-only notes — separate table so they can never be rendered to customers (ADR-013). */
export const internalNotes = pgTable(
  'internal_notes',
  {
    id: id(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    authorId: uuid()
      .notNull()
      .references(() => users.id),
    body: text().notNull(),
    passToAgent: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('internal_notes_conversation_idx').on(t.conversationId, t.createdAt)],
);

export const conversationSummaries = pgTable(
  'conversation_summaries',
  {
    id: id(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    coversThroughSeq: integer().notNull(),
    kind: text().$type<'ROLLING' | 'HANDOVER'>().notNull().default('ROLLING'),
    text: text().notNull(),
    usageEventId: uuid(),
    createdBy: uuid(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('conversation_summaries_version_uq').on(t.conversationId, t.kind, t.version)],
);

export const copilotSuggestions = pgTable(
  'copilot_suggestions',
  {
    id: id(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    basedOnSeq: integer().notNull(),
    text: text().notNull(),
    rationale: text(),
    status: text().$type<'READY' | 'INSERTED' | 'DISMISSED'>().notNull().default('READY'),
    usageEventId: uuid(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('copilot_suggestions_conversation_idx').on(t.conversationId, t.createdAt)],
);
