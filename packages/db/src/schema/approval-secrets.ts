import { check, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt } from './columns.js';

/**
 * The secret refs maker–checker owns (PM/research/11b "payloads never carry a secret", wave 2
 * COVERAGE-PLATFORM). STAGED: a value stored at submit for one object by one maker — the only refs a
 * proposal payload may carry. RELEASED: a ref an approved change or a delete stopped using; the row is
 * written in the activation transaction, so the secret is deleted only after that commits (the store is
 * not transactional). The leader sweep deletes RELEASED secrets and STAGED ones no open proposal carries.
 */
export const approvalSecretRefs = pgTable(
  'approval_secret_refs',
  {
    ref: text().primaryKey(),
    objectKind: text('object_kind').notNull(),
    objectId: uuid('object_id').notNull(),
    makerId: uuid('maker_id'),
    state: text().$type<'STAGED' | 'RELEASED'>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('approval_secret_refs_object_idx').on(t.objectKind, t.objectId),
    index('approval_secret_refs_state_idx').on(t.state, t.createdAt),
    check('approval_secret_refs_state_ck', sql`${t.state} IN ('STAGED', 'RELEASED')`),
  ],
);
