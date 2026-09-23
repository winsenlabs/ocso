import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './columns.js';
import { users } from './identity.js';

/**
 * Maker–checker (PM/research/11 §4, 11b). One proposal per change to one
 * configuration object; at most one open proposal per object. "Approved" is
 * derived from this table, never stored on the object. Migration 0023.
 */
export const approvalProposals = pgTable(
  'approval_proposals',
  {
    id: id(),
    /** Descriptor kind: 'agent', 'queue', 'router', 'permission_change', … (also the audit target_type). */
    objectKind: text().notNull(),
    /** No FK: kinds live in different tables (the audit_events precedent). */
    objectId: uuid().notNull(),
    action: text().$type<'CREATE' | 'UPDATE' | 'DELETE' | 'ACTIVATE'>().notNull(),
    status: text().$type<'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN' | 'BLOCKED' | 'VOID'>().notNull().default('SUBMITTED'),
    /** USER, or MIGRATION for configuration that predates maker-checker (0027). */
    origin: text().$type<'USER' | 'MIGRATION'>().notNull().default('USER'),
    revision: integer().notNull().default(1),
    /** Validated input to apply on activation. Never returned over HTTP; never carries a secret value. */
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    beforeSnapshot: jsonb().$type<Record<string, unknown> | null>(),
    afterSnapshot: jsonb().$type<Record<string, unknown> | null>(),
    contentHash: text().notNull(),
    dependencyKeys: text().array().notNull().default(sql`'{}'::text[]`),
    dependencyHash: text().notNull(),
    /** Owning teams at submit; '{}' = platform-wide. */
    teamIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    title: text().notNull(),
    reason: text().notNull(),
    makerId: uuid().references(() => users.id),
    checkerId: uuid().references(() => users.id),
    checkerValid: boolean().notNull().default(true),
    editedAfterSubmission: boolean().notNull().default(false),
    /** Approved by the maker because no other eligible checker existed (exception report). */
    bootstrap: boolean().notNull().default(false),
    warnings: jsonb().$type<unknown[]>().notNull().default([]),
    submittedAt: ts('submitted_at').notNull().defaultNow(),
    notifiedAt: ts('notified_at'),
    decidedAt: ts('decided_at'),
    decidedBy: uuid().references(() => users.id),
    decisionReason: text(),
    activatedAt: ts('activated_at'),
    activationAttempts: integer().notNull().default(0),
    blockedReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('approval_proposals_action_ck', sql`${t.action} IN ('CREATE','UPDATE','DELETE','ACTIVATE')`),
    check('approval_proposals_status_ck', sql`${t.status} IN ('SUBMITTED','APPROVED','REJECTED','WITHDRAWN','BLOCKED','VOID')`),
    check('approval_proposals_self_ck', sql`${t.makerId} IS NULL OR ${t.checkerId} IS NULL OR ${t.makerId} <> ${t.checkerId} OR ${t.bootstrap}`),
    check('approval_proposals_open_ck', sql`${t.status} <> 'SUBMITTED' OR (${t.makerId} IS NOT NULL AND ${t.checkerId} IS NOT NULL)`),
    // Nobody decides their own change, except a recorded bootstrap; withdrawing or voiding is not a decision on the merits.
    check(
      'approval_proposals_decider_ck',
      sql`${t.decidedBy} IS NULL OR ${t.makerId} IS NULL OR ${t.decidedBy} <> ${t.makerId} OR ${t.bootstrap} OR ${t.status} IN ('WITHDRAWN','VOID')`,
    ),
    uniqueIndex('approval_proposals_open_uq').on(t.objectKind, t.objectId).where(sql`${t.status} = 'SUBMITTED'`),
    index('approval_proposals_checker_idx').on(t.checkerId, t.status, t.submittedAt),
    index('approval_proposals_maker_idx').on(t.makerId, t.submittedAt),
    index('approval_proposals_open_idx').on(t.submittedAt).where(sql`${t.status} = 'SUBMITTED'`),
    index('approval_proposals_object_idx').on(t.objectKind, t.objectId, t.submittedAt),
    index('approval_proposals_page_idx').on(t.submittedAt, t.id),
    index('approval_proposals_teams_idx').using('gin', t.teamIds),
    index('approval_proposals_activate_idx').on(t.status).where(sql`${t.status} = 'APPROVED' AND ${t.activatedAt} IS NULL`),
  ],
);

/** Append-only history of every decision on a proposal (UPDATE/DELETE/TRUNCATE rejected by triggers, 0023). */
export const approvalDecisions = pgTable(
  'approval_decisions',
  {
    id: id(),
    proposalId: uuid()
      .notNull()
      .references(() => approvalProposals.id, { onDelete: 'restrict' }),
    revision: integer().notNull(),
    kind: text()
      .$type<'SUBMIT' | 'EDIT' | 'APPROVE' | 'BOOTSTRAP_APPROVE' | 'REJECT' | 'WITHDRAW' | 'REASSIGN' | 'BLOCK' | 'VOID' | 'ACTIVATE'>()
      .notNull(),
    actorId: uuid().references(() => users.id),
    actorName: text().notNull(),
    reason: text(),
    /** Exactly what the actor saw. */
    contentHash: text().notNull(),
    diff: jsonb().$type<unknown[]>().notNull().default([]),
    warnings: jsonb().$type<unknown[]>().notNull().default([]),
    bulkBatchId: uuid(),
    auditEventId: uuid(),
    /** INTERNAL_AGENT when Ask OCSO ran the route for the actor ("submitted via Ask OCSO"); null for the UI and API (0034). */
    via: text().$type<'INTERNAL_AGENT'>(),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'approval_decisions_kind_ck',
      sql`${t.kind} IN ('SUBMIT','EDIT','APPROVE','BOOTSTRAP_APPROVE','REJECT','WITHDRAW','REASSIGN','BLOCK','VOID','ACTIVATE')`,
    ),
    index('approval_decisions_proposal_idx').on(t.proposalId, t.occurredAt),
    index('approval_decisions_kind_idx').on(t.kind, t.occurredAt),
    index('approval_decisions_bulk_idx').on(t.bulkBatchId).where(sql`${t.bulkBatchId} IS NOT NULL`),
  ],
);
