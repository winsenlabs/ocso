import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { approvalProposals, approvalSecretRefs, type Db, type DbOrTx } from '@ocso/db';
import type { SecretKind, SecretStore } from '@ocso/secrets';
import type { ApprovalProblem, ProposalRow } from '../approvals/contract.js';

/**
 * Who owns the secret refs a platform proposal carries (PM/research/11b "payloads never carry a secret",
 * wave 2 COVERAGE-PLATFORM, table approval_secret_refs):
 * - a payload may carry only refs STAGED for that object by that maker at submit — never another object's
 *   live credential, which refs readable elsewhere (GET /v1/channels, /v1/secrets) would otherwise allow;
 * - activation CLAIMS the staged refs (they now belong to the object) and RELEASES the ones it stopped
 *   using — a row written in the activation transaction, so the SecretStore (not transactional) deletes
 *   them only after that commits;
 * - the leader sweep deletes RELEASED secrets and STAGED ones no open proposal carries any more (rejected,
 *   withdrawn, voided, blocked, or replaced by an edit).
 */

export interface SecretOwner {
  kind: string;
  objectId: string;
}

/** A staged value as the payload carries it: `{field, ref}` (settings/platform-approvals.ts StoredCredential). */
export interface StagedSecret {
  field: string;
  ref: string;
}

/** Store each plaintext value as a NEW secret, recorded as staged for this object and maker. */
export async function stageSecrets(
  db: Db,
  secrets: SecretStore,
  owner: SecretOwner & { makerId: string },
  meta: { name: string; kind: (field: string) => SecretKind; usedBy: string },
  values: Readonly<Record<string, string>>,
): Promise<StagedSecret[]> {
  const staged: StagedSecret[] = [];
  try {
    for (const [field, value] of Object.entries(values)) {
      const stored = await secrets.put({ name: `${meta.name} ${field} (proposed)`.trim(), kind: meta.kind(field), value, usedBy: meta.usedBy });
      staged.push({ field, ref: stored.ref });
    }
    if (staged.length) {
      await db.insert(approvalSecretRefs).values(staged.map((s) => ({ ref: s.ref, objectKind: owner.kind, objectId: owner.objectId, makerId: owner.makerId, state: 'STAGED' as const })));
    }
  } catch (err) {
    await unstageSecrets(db, secrets, staged.map((s) => s.ref));
    throw err;
  }
  return staged;
}

/** A submit that failed: its staged values are deleted right away (the sweep would, later). */
export async function unstageSecrets(db: Db, secrets: SecretStore, refs: readonly string[]): Promise<void> {
  if (!refs.length) return;
  for (const ref of refs) await secrets.delete(ref).catch(() => undefined);
  await db.delete(approvalSecretRefs).where(and(inArray(approvalSecretRefs.ref, [...refs]), eq(approvalSecretRefs.state, 'STAGED'))).catch(() => undefined);
}

/** Refs in a payload that were not staged for this object by this proposal's maker (hard problem). */
export async function unstagedRefProblems(tx: DbOrTx, p: Pick<ProposalRow, 'objectKind' | 'objectId' | 'makerId'>, refs: ReadonlyArray<string | null | undefined>): Promise<ApprovalProblem[]> {
  const wanted = [...new Set(refs.filter((r): r is string => Boolean(r)))];
  if (!wanted.length) return [];
  const rows = await tx
    .select({ ref: approvalSecretRefs.ref, makerId: approvalSecretRefs.makerId })
    .from(approvalSecretRefs)
    .where(and(inArray(approvalSecretRefs.ref, wanted), eq(approvalSecretRefs.state, 'STAGED'), eq(approvalSecretRefs.objectKind, p.objectKind), eq(approvalSecretRefs.objectId, p.objectId)));
  const own = new Set(rows.filter((r) => r.makerId === p.makerId).map((r) => r.ref));
  return wanted.some((r) => !own.has(r))
    ? [{ code: 'secret_ref_not_staged', message: 'A credential in this change was not entered with it: enter the new value in the change itself.' }]
    : [];
}

/** At activation: the staged refs now belong to the object (never swept). */
export async function claimSecrets(tx: DbOrTx, refs: ReadonlyArray<string | null | undefined>): Promise<void> {
  const list = [...new Set(refs.filter((r): r is string => Boolean(r)))];
  if (list.length) await tx.delete(approvalSecretRefs).where(and(inArray(approvalSecretRefs.ref, list), eq(approvalSecretRefs.state, 'STAGED')));
}

/** In the activation transaction: refs the object stopped using, deleted from the store after commit (by the sweep). */
export async function releaseSecrets(tx: DbOrTx, owner: SecretOwner, refs: ReadonlyArray<string | null | undefined>): Promise<void> {
  const list = [...new Set(refs.filter((r): r is string => Boolean(r)))];
  if (!list.length) return;
  await tx
    .insert(approvalSecretRefs)
    .values(list.map((ref) => ({ ref, objectKind: owner.kind, objectId: owner.objectId, makerId: null, state: 'RELEASED' as const })))
    .onConflictDoUpdate({ target: approvalSecretRefs.ref, set: { state: 'RELEASED' } });
}

/** A staged value is left for this long before the sweep may judge it orphaned (a submit in flight). */
export const STAGED_GRACE_MS = 15 * 60_000;

export interface SecretSweep {
  released: number;
  orphaned: number;
}

/**
 * Leader sweep: delete RELEASED secrets (their activation committed), and STAGED ones older than the grace
 * period that no open or activating proposal on their object carries any more.
 */
export async function sweepApprovalSecrets(db: Db, secrets: SecretStore, o: { now?: Date; graceMs?: number } = {}): Promise<SecretSweep> {
  const now = o.now ?? new Date();
  const out: SecretSweep = { released: 0, orphaned: 0 };
  const released = await db.select({ ref: approvalSecretRefs.ref }).from(approvalSecretRefs).where(eq(approvalSecretRefs.state, 'RELEASED')).limit(500);
  for (const { ref } of released) {
    await secrets.delete(ref).catch(() => undefined);
    await db.delete(approvalSecretRefs).where(and(eq(approvalSecretRefs.ref, ref), eq(approvalSecretRefs.state, 'RELEASED')));
    out.released += 1;
  }
  const cutoff = new Date(now.getTime() - (o.graceMs ?? STAGED_GRACE_MS));
  const staged = await db.select().from(approvalSecretRefs).where(and(eq(approvalSecretRefs.state, 'STAGED'), lt(approvalSecretRefs.createdAt, cutoff))).limit(500);
  for (const row of staged) {
    const carried = await db.transaction(async (tx) => {
      const [p] = await tx
        .select({ id: approvalProposals.id })
        .from(approvalProposals)
        .where(
          and(
            eq(approvalProposals.objectKind, row.objectKind),
            eq(approvalProposals.objectId, row.objectId),
            sql`strpos(${approvalProposals.payload}::text, ${row.ref}) > 0`,
            or(eq(approvalProposals.status, 'SUBMITTED'), and(eq(approvalProposals.status, 'APPROVED'), isNull(approvalProposals.activatedAt))),
          ),
        )
        .limit(1);
      if (p) return true;
      const [gone] = await tx.delete(approvalSecretRefs).where(and(eq(approvalSecretRefs.ref, row.ref), eq(approvalSecretRefs.state, 'STAGED'))).returning({ ref: approvalSecretRefs.ref });
      return !gone;
    });
    if (carried) continue;
    await secrets.delete(row.ref).catch(() => undefined);
    out.orphaned += 1;
  }
  return out;
}
