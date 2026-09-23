import { sql } from 'drizzle-orm';
import { bigint, boolean, check, integer, jsonb, pgTable, real, smallint, text, uuid } from 'drizzle-orm/pg-core';
import { ts, updatedAt } from './columns.js';

/** Singleton (id = 1): organization identity and deployment-wide policy (ADR-002). */
export const deploymentSettings = pgTable('deployment_settings', {
  id: smallint().primaryKey().default(1),
  orgName: text().notNull().default('My organization'),
  deploymentLabel: text().notNull().default('PROD'),
  regionLabel: text(),
  timezone: text().notNull().default('UTC'),
  residencyZone: text(),
  providerAllowlist: text().array().notNull().default(sql`'{}'::text[]`),
  allowCrossProviderFallback: boolean().notNull().default(false),
  allowCrossRegionFallback: boolean().notNull().default(false),
  maxOutputCostPerMTokMicros: bigint({ mode: 'number' }),
  execsCanViewAiActive: boolean().notNull().default(true),
  retention: jsonb().$type<Record<string, number>>().notNull().default({}),
  egressAllowedInternalHosts: text().array().notNull().default(sql`'{}'::text[]`),
  /** Logical model profile used by the internal OCSO agent (docs/12). */
  internalAgentProfileId: uuid(),
  /** Require explicit confirmation for LOW_WRITE internal-agent actions too. */
  internalAgentConfirmLowWrites: boolean().notNull().default(false),
  setupCompletedAt: ts('setup_completed_at'),
  /** Open approvals older than this carry the `aged` warning and appear in the exception report (0023). */
  approvalAgeWarningHours: integer().notNull().default(72),
  /** Audit events verified in the audit store are pruned from the main database after this many days (≥ 90, the widest analytics window; CHECK in 0026). */
  auditLocalWindowDays: integer().notNull().default(90),
  updatedAt: updatedAt(),
  updatedBy: uuid(),
});

/** Singleton (id = 1): worker capacity and scaling configuration (docs/10 §5). */
export const workerSettings = pgTable('worker_settings', {
  id: smallint().primaryKey().default(1),
  minWarmWorkers: integer().notNull().default(2),
  maxWorkers: integer().notNull().default(10),
  conversationsPerWorker: integer().notNull().default(10),
  targetUtilization: real().notNull().default(0.75),
  scaleOutQueueAgeSeconds: integer().notNull().default(10),
  scaleOutQueueDepth: integer().notNull().default(20),
  scaleInCooldownSeconds: integer().notNull().default(180),
  turnTimeoutSeconds: integer().notNull().default(90),
  leaseDurationSeconds: integer().notNull().default(45),
  heartbeatIntervalSeconds: integer().notNull().default(10),
  idleLeaseSeconds: integer().notNull().default(300),
  autoscalingEnabled: boolean().notNull().default(false),
  updatedAt: updatedAt(),
  updatedBy: uuid(),
});

/**
 * Singleton (id = 1): the last time the worker leader applied worker_settings
 * to the deployment platform (ADR-023), and its last describe() snapshot. The
 * API serves this, so it never needs the platform's scaling permissions.
 */
export const workerScalingState = pgTable(
  'worker_scaling_state',
  {
    id: smallint().primaryKey().default(1),
    /** DEPLOYMENT_DRIVER that recorded it (any registered driver name). */
    driver: text().notNull(),
    applyStatus: text().$type<'APPLIED' | 'ADVISORY' | 'FAILED'>().notNull(),
    /** Advisory text, summary, or failure reason — operator-facing. */
    applyMessage: text().notNull(),
    /** ScalingApplyResult (commands, changes, warnings, effective values) or the error code. */
    applyDetail: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    attemptedAt: ts('attempted_at').notNull(),
    lastSucceededAt: ts('last_succeeded_at'),
    /** worker_settings.updated_at the attempt applied; older than the settings = pending. */
    settingsUpdatedAt: ts('settings_updated_at').notNull(),
    deployment: jsonb().$type<Record<string, unknown>>(),
    describedAt: ts('described_at'),
    describeError: text(),
    updatedAt: updatedAt(),
  },
  (t) => [check('worker_scaling_state_singleton_ck', sql`${t.id} = 1`)],
);
