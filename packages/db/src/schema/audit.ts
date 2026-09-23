import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, ts } from './columns.js';

/**
 * Immutable record of privileged actions (docs/15 §7), written in the same
 * transaction as the change. Since ADR-032 it is also the transactional outbox
 * of the audit store: the worker ships rows (`shipped_at`), reconciliation
 * proves the store holds them (`verified_at`), and verified rows older than the
 * local window are pruned. The trigger (0001, replaced in 0026) permits only
 * those two stamps to change and only those deletes.
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
    /** Target's teams ∪ actor's teams at write time: the read scope in the audit store (auditTeams). */
    teamIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /** Appended to the audit store (the shipper); cleared again if reconciliation finds it missing. */
    shippedAt: ts('shipped_at'),
    /** The store was seen holding it (reconciliation); only verified rows may be pruned locally. */
    verifiedAt: ts('verified_at'),
  },
  (t) => [
    index('audit_events_time_idx').on(t.occurredAt),
    index('audit_events_target_idx').on(t.targetType, t.targetId),
    index('audit_events_actor_idx').on(t.actorId, t.occurredAt),
    index('audit_events_unshipped_idx').on(t.occurredAt, t.id).where(sql`${t.shippedAt} IS NULL`),
    index('audit_events_unverified_idx').on(t.shippedAt).where(sql`${t.shippedAt} IS NOT NULL AND ${t.verifiedAt} IS NULL`),
    index('audit_events_team_ids_idx').using('gin', t.teamIds),
  ],
);

export const AUDIT_INCIDENT_KINDS = ['SHIP_FAILED', 'STORE_DOWN', 'RECONCILE_MISSING', 'CHAIN_BROKEN', 'EXPORT_FAILED', 'SIGNING_KEY_CHANGED'] as const;
export type AuditIncidentKind = (typeof AUDIT_INCIDENT_KINDS)[number];

/**
 * Problems moving audit events to the store or keeping it sound (ADR-032):
 * one open row per kind, counted while it recurs; resolved when the condition
 * clears. CHAIN_BROKEN stays open until someone with audit.verify acknowledges it
 * (the acknowledgement is audited and kept in `detail`). The exception report lists them.
 */
export const auditIncidents = pgTable(
  'audit_incidents',
  {
    id: id(),
    kind: text().$type<AuditIncidentKind>().notNull(),
    detail: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    firstSeen: ts('first_seen').notNull().defaultNow(),
    lastSeen: ts('last_seen').notNull().defaultNow(),
    count: integer().notNull().default(1),
    resolvedAt: ts('resolved_at'),
  },
  (t) => [
    uniqueIndex('audit_incidents_open_uq').on(t.kind).where(sql`${t.resolvedAt} IS NULL`),
    index('audit_incidents_seen_idx').on(t.lastSeen),
    check('audit_incidents_kind_ck', sql`${t.kind} IN ('SHIP_FAILED', 'STORE_DOWN', 'RECONCILE_MISSING', 'CHAIN_BROKEN', 'EXPORT_FAILED', 'SIGNING_KEY_CHANGED')`),
  ],
);

/** Signed exports of sealed chain ranges to the BlobStore (the audit-export task). */
export const auditExports = pgTable(
  'audit_exports',
  {
    id: id(),
    fromPosition: bigint({ mode: 'number' }).notNull(),
    toPosition: bigint({ mode: 'number' }).notNull(),
    records: integer().notNull(),
    blobKey: text().notNull(),
    manifestKey: text().notNull(),
    sha256: text().notNull(),
    checkpointId: uuid().notNull(),
    keyId: text().notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('audit_exports_range_uq').on(t.fromPosition), check('audit_exports_range_ck', sql`${t.toPosition} >= ${t.fromPosition}`)],
);

/**
 * Full-chain verifications (the audit-verify-full leader task): a run walks the
 * whole chain in bounded pages, resuming at `checked_to`, and finishes with
 * `ok` and the problems it found. The System screen shows the last finished run.
 */
export const auditVerifications = pgTable(
  'audit_verifications',
  {
    id: id(),
    startedAt: ts('started_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
    headAtStart: bigint({ mode: 'number' }).notNull(),
    checkedTo: bigint({ mode: 'number' }).notNull().default(0),
    entries: bigint({ mode: 'number' }).notNull().default(0),
    ok: boolean().notNull().default(true),
    problems: jsonb().$type<Array<Record<string, unknown>>>().notNull().default([]),
  },
  (t) => [index('audit_verifications_started_idx').on(t.startedAt)],
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
