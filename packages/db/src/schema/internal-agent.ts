import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { channelAccountLinks } from './channel-links.js';
import { createdAt, id, ts, updatedAt } from './columns.js';
import { users } from './identity.js';

/** Conversations between a staff user and the internal OCSO agent (docs/archive/specs/12). */
export const internalAgentThreads = pgTable(
  'internal_agent_threads',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text().notNull().default('New conversation'),
    context: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** Where the thread was asked from (0036): null = the drawer; otherwise the chat channel's kind in lower case (`slack`). */
    surface: text(),
    /** The linked chat account a chat thread runs as (0036); null for drawer threads. */
    channelLinkId: uuid().references(() => channelAccountLinks.id, { onDelete: 'set null' }),
    /** The chat thread it continues (a digest of the adapter's reply context), unique per link. */
    chatThreadKey: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('internal_agent_threads_user_idx').on(t.userId, t.updatedAt),
    uniqueIndex('internal_agent_threads_chat_uq').on(t.channelLinkId, t.chatThreadKey).where(sql`${t.channelLinkId} IS NOT NULL`),
  ],
);

export const internalAgentMessages = pgTable(
  'internal_agent_messages',
  {
    id: id(),
    threadId: uuid()
      .notNull()
      .references(() => internalAgentThreads.id, { onDelete: 'cascade' }),
    role: text().$type<'user' | 'assistant'>().notNull(),
    parts: jsonb().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('internal_agent_messages_thread_idx').on(t.threadId, t.createdAt)],
);

/** Confirmation cards: every write Ask OCSO proposes waits for the same user's click (PM/research/12 §5). */
export const internalAgentActions = pgTable(
  'internal_agent_actions',
  {
    id: id(),
    threadId: uuid()
      .notNull()
      .references(() => internalAgentThreads.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    tool: text().notNull(),
    params: jsonb().notNull(),
    risk: text().$type<'READ' | 'LOW_WRITE' | 'HIGH_WRITE'>().notNull(),
    description: text().notNull(),
    /** CONFIRMING: claimed by a confirm while the route runs (single use). SUBMITTED: a governed card became a proposal. */
    status: text().$type<'PENDING' | 'CONFIRMING' | 'EXECUTED' | 'SUBMITTED' | 'REJECTED' | 'EXPIRED' | 'FAILED' | 'STALE' | 'UNKNOWN'>().notNull().default('PENDING'),
    result: jsonb(),
    auditEventId: uuid(),
    /** The confirmation card as the drawer shows it (PM/research/12 §5); null on rows from before cards (0034). */
    card: jsonb().$type<Record<string, unknown>>(),
    /** sha256 of (tool, arguments, object state) when the card was built: a changed object makes the card STALE. */
    cardHash: text(),
    /** The model's tool call that asked for it. */
    callId: text(),
    /** The approval proposal a governed card submitted. */
    proposalId: uuid(),
    expiresAt: ts('expires_at').notNull(),
    decidedAt: ts('decided_at'),
    createdAt: createdAt(),
  },
  (t) => [index('internal_agent_actions_user_idx').on(t.userId, t.status), index('internal_agent_actions_thread_idx').on(t.threadId)],
);
