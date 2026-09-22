import { boolean, index, integer, jsonb, pgTable, real, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts } from './columns.js';
import { users } from './identity.js';

/**
 * Explicit, auditable classifier output per conversation (docs/11 §3). The
 * method (prompt + profile) is recorded so every number can be explained.
 */
export const conversationInsights = pgTable(
  'conversation_insights',
  {
    conversationId: uuid().primaryKey(),
    agentId: uuid().notNull(),
    topic: text(),
    outcome: text().$type<'RESOLVED_BY_AI' | 'RESOLVED_BY_HUMAN' | 'ESCALATED' | 'ABANDONED' | 'UNRESOLVED'>(),
    escalationReason: text(),
    knowledgeGap: text(),
    failureTopic: text(),
    sentiment: text().$type<'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'>(),
    salesOutcome: text(),
    turnsBeforeEscalation: integer(),
    methodVersion: text().notNull(),
    usageEventId: uuid(),
    generatedAt: ts('generated_at').notNull().defaultNow(),
  },
  (t) => [index('conversation_insights_agent_idx').on(t.agentId, t.generatedAt)],
);

export const conversationReviews = pgTable(
  'conversation_reviews',
  {
    id: id(),
    conversationId: uuid().notNull(),
    agentId: uuid().notNull(),
    reviewerId: uuid()
      .notNull()
      .references(() => users.id),
    outcomeTag: text().notNull(),
    /** Rubric-based 1–5 score; rubric stored alongside for auditability. */
    score: real().notNull(),
    rubric: jsonb().$type<Record<string, number>>().notNull().default({}),
    notes: text(),
    createdAt: createdAt(),
  },
  (t) => [index('conversation_reviews_agent_idx').on(t.agentId, t.createdAt)],
);

export const csatResponses = pgTable(
  'csat_responses',
  {
    id: id(),
    conversationId: uuid().notNull(),
    agentId: uuid().notNull(),
    handledByHuman: boolean().notNull().default(false),
    score: integer().notNull(),
    comment: text(),
    receivedAt: ts('received_at').notNull().defaultNow(),
  },
  (t) => [index('csat_responses_agent_idx').on(t.agentId, t.receivedAt)],
);

/** Replay evaluation of a candidate prompt against historical turns (no side effects). */
export const evaluationRuns = pgTable('evaluation_runs', {
  id: id(),
  agentId: uuid().notNull(),
  baselineVersionId: uuid(),
  candidateComponents: jsonb().$type<Record<string, string>>().notNull(),
  status: text().$type<'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'>().notNull().default('QUEUED'),
  caseCount: integer().notNull(),
  summary: jsonb().$type<Record<string, number>>(),
  createdBy: uuid().references(() => users.id),
  createdAt: createdAt(),
  completedAt: ts('completed_at'),
});

export const evaluationResults = pgTable(
  'evaluation_results',
  {
    id: id(),
    runId: uuid().notNull(),
    conversationId: uuid().notNull(),
    seq: integer().notNull(),
    customerText: text().notNull(),
    baselineText: text(),
    candidateText: text(),
    candidateToolCalls: jsonb(),
    changed: boolean().notNull().default(false),
    flags: text().array(),
    createdAt: createdAt(),
  },
  (t) => [index('evaluation_results_run_idx').on(t.runId)],
);
