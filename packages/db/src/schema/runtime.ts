import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgTable, real, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, ts } from './columns.js';

/** Registered worker processes and their heartbeats (docs/archive/specs/10). */
export const workers = pgTable(
  'workers',
  {
    id: text().primaryKey(),
    hostname: text().notNull(),
    version: text().notNull(),
    status: text().$type<'STARTING' | 'HEALTHY' | 'DRAINING' | 'STOPPED' | 'LOST'>().notNull().default('STARTING'),
    capacity: integer().notNull(),
    activeLeases: integer().notNull().default(0),
    busyTurns: integer().notNull().default(0),
    cpuPercent: real(),
    memoryMb: real(),
    platformRef: text(),
    startedAt: ts('started_at').notNull().defaultNow(),
    heartbeatAt: ts('heartbeat_at').notNull().defaultNow(),
    stoppedAt: ts('stopped_at'),
  },
  (t) => [index('workers_heartbeat_idx').on(t.status, t.heartbeatAt)],
);

/** Conversation ownership lease with fencing version (ADR-008). */
export const conversationLeases = pgTable(
  'conversation_leases',
  {
    conversationId: uuid().primaryKey(),
    workerId: text().notNull(),
    leaseVersion: bigint({ mode: 'number' }).notNull(),
    busy: boolean().notNull().default(false),
    acquiredAt: ts('acquired_at').notNull().defaultNow(),
    heartbeatAt: ts('heartbeat_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('conversation_leases_worker_idx').on(t.workerId), index('conversation_leases_expiry_idx').on(t.expiresAt)],
);

/** Postgres queue (ADR-008). */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid().primaryKey(),
    topic: text().notNull(),
    payload: jsonb().notNull(),
    groupKey: text(),
    dedupeKey: text(),
    status: text().$type<'queued' | 'running' | 'done' | 'dead'>().notNull().default('queued'),
    attempts: integer().notNull().default(0),
    availableAt: ts('available_at').notNull().defaultNow(),
    lockedBy: text(),
    lockedUntil: ts('locked_until'),
    lastError: text(),
    enqueuedAt: ts('enqueued_at').notNull().defaultNow(),
    completedAt: ts('completed_at'),
  },
  (t) => [
    uniqueIndex('jobs_dedupe_uq')
      .on(t.topic, t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL AND ${t.status} IN ('queued', 'running')`),
    index('jobs_claim_idx').on(t.topic, t.availableAt).where(sql`${t.status} = 'queued'`),
    index('jobs_running_idx').on(t.topic, t.lockedUntil).where(sql`${t.status} = 'running'`),
    index('jobs_group_idx').on(t.groupKey).where(sql`${t.status} IN ('queued', 'running')`),
  ],
);

/** Relay for delays beyond the queue driver's limit (SQS 900 s), identical in both modes. */
export const scheduledJobs = pgTable(
  'scheduled_jobs',
  {
    id: uuid().primaryKey(),
    topic: text().notNull(),
    payload: jsonb().notNull(),
    groupKey: text(),
    dedupeKey: text(),
    runAt: ts('run_at').notNull(),
    dispatchedAt: ts('dispatched_at'),
    createdAt: createdAt(),
  },
  (t) => [index('scheduled_jobs_due_idx').on(t.runAt).where(sql`${t.dispatchedAt} IS NULL`)],
);

/** Last compiled context per conversation, for warm recovery on another worker (docs/archive/specs/05 §4). */
export const contextSnapshots = pgTable('context_snapshots', {
  conversationId: uuid().primaryKey(),
  hashes: jsonb().$type<Record<string, string | null>>().notNull(),
  generations: jsonb().$type<Record<string, number>>().notNull(),
  snapshot: jsonb().notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Monotonic invalidation counters per cache scope (docs/archive/specs/05 §5). */
export const cacheGenerations = pgTable('cache_generations', {
  scope: text().primaryKey(),
  generation: bigint({ mode: 'number' }).notNull().default(1),
  reason: text(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Periodic component health samples (uptime, dependency health). */
export const healthSamples = pgTable(
  'health_samples',
  {
    id: uuid().primaryKey(),
    component: text().notNull(),
    status: text().$type<'OK' | 'DEGRADED' | 'DOWN'>().notNull(),
    latencyMs: integer(),
    detail: text(),
    sampledAt: ts('sampled_at').notNull().defaultNow(),
  },
  (t) => [index('health_samples_component_idx').on(t.component, t.sampledAt)],
);
