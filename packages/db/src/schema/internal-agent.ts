import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './columns.js';
import { users } from './identity.js';

/** Conversations between a staff user and the internal OCSO agent (docs/12). */
export const internalAgentThreads = pgTable(
  'internal_agent_threads',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text().notNull().default('New conversation'),
    context: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('internal_agent_threads_user_idx').on(t.userId, t.updatedAt)],
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

/** Write actions proposed by the internal agent; HIGH_WRITE requires explicit confirmation. */
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
    status: text().$type<'PENDING' | 'EXECUTED' | 'REJECTED' | 'EXPIRED' | 'FAILED'>().notNull().default('PENDING'),
    result: jsonb(),
    auditEventId: uuid(),
    expiresAt: ts('expires_at').notNull(),
    decidedAt: ts('decided_at'),
    createdAt: createdAt(),
  },
  (t) => [index('internal_agent_actions_user_idx').on(t.userId, t.status)],
);
