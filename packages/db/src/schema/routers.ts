import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt } from './columns.js';
import { users } from './identity.js';

/**
 * Routers (PM/research/11 §5): `channel → router → queue → agent`. A router's
 * behaviour is an immutable version (the definition is validated by
 * `@ocso/domain` RouterDefinitionSchema); the draft is the one editable copy.
 * A router never approved is DRAFT and routes nothing. Migration 0024.
 */
export const routers = pgTable(
  'routers',
  {
    id: id(),
    name: text().notNull(),
    description: text().notNull().default(''),
    status: text().$type<'DRAFT' | 'ACTIVE' | 'DISABLED'>().notNull().default('DRAFT'),
    /** The version ingress uses (validated by the application; no FK so a version can be inserted first). */
    activeVersionId: uuid(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('routers_name_uq').on(sql`lower(${t.name})`), check('routers_status_ck', sql`${t.status} IN ('DRAFT','ACTIVE','DISABLED')`)],
);

/** Frozen router definitions; UPDATE/DELETE are rejected by a trigger (like prompt_versions). */
export const routerVersions = pgTable(
  'router_versions',
  {
    id: id(),
    routerId: uuid()
      .notNull()
      .references(() => routers.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    definition: jsonb().$type<Record<string, unknown>>().notNull(),
    reason: text().notNull().default(''),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('router_versions_router_version_uq').on(t.routerId, t.version)],
);

/** The router's working copy: freely editable, inert until frozen into a version and activated. */
export const routerDrafts = pgTable('router_drafts', {
  routerId: uuid()
    .primaryKey()
    .references(() => routers.id, { onDelete: 'cascade' }),
  definition: jsonb().$type<Record<string, unknown>>().notNull(),
  updatedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
});

export type RoutingPhase = 'RETURNING' | 'STEPS' | 'DONE';
/** How the router decided (NEW: the customer chose a new conversation at the continue-or-new prompt). */
export type RoutingOutcome = 'RULE' | 'MODEL' | 'FALLBACK' | 'PASS_THROUGH' | 'CONTINUE' | 'TIMEOUT' | 'NEW';
