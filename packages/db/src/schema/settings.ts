import { sql } from 'drizzle-orm';
import { bigint, boolean, integer, jsonb, pgTable, real, smallint, text, uuid } from 'drizzle-orm/pg-core';
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
