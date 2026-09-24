import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, real, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './columns.js';
import { customers, channels } from './customers.js';
import { users } from './identity.js';
import { virtualAgents } from './agents.js';
import { queues } from './routing.js';
import { routerVersions, routers, type RoutingOutcome, type RoutingPhase } from './routers.js';

/** Allowlisted key/values an embedding site passed for a conversation, and who vouched for them. */
export interface HostContext {
  source: 'host' | 'client';
  values: Record<string, string | number | boolean>;
  /** ISO time the session carrying these values was opened. */
  at: string;
}

export const conversations = pgTable(
  'conversations',
  {
    id: id(),
    customerId: uuid()
      .notNull()
      .references(() => customers.id),
    /** The one agent answering (PM/research/11 §5.5); null only while a router is still deciding (ROUTING). */
    agentId: uuid().references(() => virtualAgents.id),
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
    /** Insights job requested for the resolution at this time (re-requested after a later resolve). */
    insightsRequestedAt: ts('insights_requested_at'),
    /** Content removed under the retention policy (metadata and analytics remain). */
    contentPurgedAt: ts('content_purged_at'),
    /** Resolution SLA deadline from the queue's policy for this conversation type (null = none). */
    resolutionDueAt: ts('resolution_due_at'),
    /**
     * Context the embedding site passed with the visitor's latest session (0032): `host` = vouched by the
     * site's backend (session pass / verified user token), `client` = sent by the browser (unverified).
     */
    hostContext: jsonb().$type<HostContext>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('conversations_state_idx').on(t.controlState, t.queueId, t.priority),
    index('conversations_customer_idx').on(t.customerId),
    index('conversations_assigned_idx').on(t.assignedUserId).where(sql`${t.controlState} <> 'RESOLVED'`),
    index('conversations_resolution_due_idx').on(t.resolutionDueAt).where(sql`${t.controlState} <> 'RESOLVED' AND ${t.resolutionDueAt} IS NOT NULL`),
    index('conversations_agent_idx').on(t.agentId, t.openedAt),
    index('conversations_recent_idx').on(t.lastInteractionAt),
    // Inbox tag filter (`tags @> ARRAY[tag]`) and tag autocomplete.
    index('conversations_tags_idx').using('gin', t.tags),
    // At most one open conversation per customer and channel (routing and transfers happen inside it).
    uniqueIndex('conversations_open_channel_uq')
      .on(t.customerId, t.channelId)
      .where(sql`${t.controlState} <> 'RESOLVED'`),
    // No agent: a router is still deciding, or it was resolved before one was chosen.
    check('conversations_agent_or_routing_ck', sql`${t.agentId} IS NOT NULL OR ${t.controlState} IN ('ROUTING', 'RESOLVED')`),
  ],
);

/**
 * Where a conversation is in its router (PM/research/11 §5.1): the version it
 * follows, the collected attributes and answers, and how it was decided.
 * `seq_from` is the conversation's last seq when routing started: the agent
 * answers every customer message after it once routing completes.
 */
export const conversationRouting = pgTable(
  'conversation_routing',
  {
    conversationId: uuid()
      .primaryKey()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    routerId: uuid().references(() => routers.id, { onDelete: 'set null' }),
    routerVersionId: uuid().references(() => routerVersions.id, { onDelete: 'set null' }),
    phase: text().$type<RoutingPhase>().notNull(),
    stepIndex: integer().notNull().default(0),
    attributes: jsonb().$type<Record<string, string>>().notNull().default({}),
    answers: jsonb().$type<Record<string, string>>().notNull().default({}),
    classifications: jsonb().$type<Record<string, { label: string | null; confidence: number; error?: string }>>().notNull().default({}),
    followUps: integer().notNull().default(0),
    attempts: integer().notNull().default(0),
    previousState: text(),
    awaitingSince: ts('awaiting_since'),
    seqFrom: integer().notNull().default(0),
    outcome: text().$type<RoutingOutcome>(),
    ruleIndex: integer(),
    queueId: uuid().references(() => queues.id, { onDelete: 'set null' }),
    decidedAt: ts('decided_at'),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('conversation_routing_awaiting_idx').on(t.awaitingSince).where(sql`${t.phase} <> 'DONE' AND ${t.awaitingSince} IS NOT NULL`),
    // Migration 0030: a router's conversations (delete blockers, per-router history).
    index('conversation_routing_router_idx').on(t.routerId),
    check('conversation_routing_phase_ck', sql`${t.phase} IN ('RETURNING','STEPS','DONE')`),
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
    /** ROUTER: a router's question to the customer (PM/research/11 §5.1). */
    actorType: text().$type<'CUSTOMER' | 'AGENT' | 'HUMAN' | 'SYSTEM' | 'TOOL' | 'ROUTER'>().notNull(),
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
    /**
     * Inbound only (0035): where replies go, in the channel adapter's terms (InboundMessage.replyContext — a Slack
     * thread, a Bot Framework conversation reference). Opaque to core; delivery hands back the one of the message a reply answers.
     */
    replyContext: jsonb().$type<Record<string, string>>(),
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
    /** Null when generated proactively for an inbound message. */
    requestedBy: uuid(),
    style: text(),
    basis: jsonb().$type<{ historyMessages: number; policyRefs: string[] }>().notNull().default({ historyMessages: 0, policyRefs: [] }),
    status: text().$type<'READY' | 'INSERTED' | 'DISMISSED'>().notNull().default('READY'),
    usageEventId: uuid(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('copilot_suggestions_conversation_idx').on(t.conversationId, t.createdAt)],
);
