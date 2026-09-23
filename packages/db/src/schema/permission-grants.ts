import { sql } from 'drizzle-orm';
import { check, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts } from './columns.js';
import { users } from './identity.js';

/**
 * Per-user permission overrides (PM/research/11 §3.3, migration 0022). A user's
 * rights are their preset plus active GRANTs minus active REVOKEs. Active =
 * not cleared and not expired; expiry is computed on read, never swept. Rows are
 * never updated except to clear them, so the table is its own history — enforced
 * by the `user_permission_grants_history` trigger (migration 0022: only setting
 * cleared_at/cleared_by once; no DELETE) and `user_id ON DELETE RESTRICT`. A
 * GRANT row exists only once approved (proposal_id names the approval; created_by
 * the maker); REVOKEs apply at once.
 */
export const userPermissionGrants = pgTable(
  'user_permission_grants',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** A catalogued permission (@ocso/auth); unknown values are ignored on read. */
    permission: text().notNull(),
    effect: text().$type<'GRANT' | 'REVOKE'>().notNull(),
    /** Only GRANTs expire. */
    expiresAt: ts('expires_at'),
    reason: text().notNull(),
    /** The approval that made this row effective; null for immediate reductions and for development-mode changes. No FK: 0023 follows. */
    proposalId: uuid(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    clearedAt: ts('cleared_at'),
    clearedBy: uuid().references(() => users.id),
  },
  (t) => [
    check('user_permission_grants_effect_ck', sql`${t.effect} IN ('GRANT','REVOKE')`),
    check('user_permission_grants_expiry_ck', sql`${t.effect} = 'GRANT' OR ${t.expiresAt} IS NULL`),
    check('user_permission_grants_cleared_ck', sql`${t.clearedBy} IS NULL OR ${t.clearedAt} IS NOT NULL`),
    // One live override per permission; it also serves the per-user lookup in loadPrincipal.
    uniqueIndex('user_permission_grants_open_uq').on(t.userId, t.permission).where(sql`${t.clearedAt} IS NULL`),
  ],
);
