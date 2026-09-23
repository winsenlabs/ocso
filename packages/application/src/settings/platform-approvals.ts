import { can, type Permission, type Principal } from '@ocso/auth';
import type { DbOrTx } from '@ocso/db';
import { describeDiff, diffFields, forbidden, type ApprovalAction } from '@ocso/domain';
import type { SecretStore } from '@ocso/secrets';
import { z } from 'zod';
import type { ProposalRow } from '../approvals/contract.js';
import { approvalOpenError, approvalRequiredError, assertUnlocked, isApproved, lockObject } from '../approvals/guard.js';
import type { ApprovalRequest } from '../approvals/inputs.js';
import { ApprovalService } from '../approvals/proposals.js';
import type { ApprovalOutcome, ApprovalTarget } from '../approvals/request.js';
import type { ActorContext } from '../shared/context.js';
import { isLivePlatformObject } from './platform-live.js';

/**
 * Shared pieces of the platform-object approval descriptors (PM/research/11 §4,
 * wave 2 COVERAGE-PLATFORM): channels, model providers/profiles/pricing, MCP
 * connections, notification destinations, webhooks, SSO providers and the
 * deployment settings. They are platform-wide (team_ids '{}': any holder of the
 * check permission may check), visible by a read permission, and serialized by
 * one advisory key per object that the direct write paths take too.
 */

/**
 * A secret value created at submit and referenced by the proposal (PM/research/11b "payloads never carry a
 * secret"). A list of {field, ref} rather than a map keyed by field: field names such as `authToken` would
 * otherwise read as credentials to the audit redactor and to reviewers.
 */
export const StoredCredential = z.object({ field: z.string().min(1).max(64), ref: z.string().min(1).max(300) });
export type StoredCredential = z.infer<typeof StoredCredential>;
export const StoredCredentials = z.array(StoredCredential).max(20);

/**
 * Best-effort delete of secrets nothing references any more, for the direct (draft) paths after their commit.
 * Approval activations never call it: they release refs (secret-refs.ts) so the delete happens after commit.
 */
export async function discardSecrets(secrets: SecretStore | undefined, refs: ReadonlyArray<string | null | undefined>): Promise<void> {
  if (!secrets) return;
  for (const ref of refs) if (ref) await secrets.delete(ref).catch(() => undefined);
}

/** Visibility of a platform object: a read permission, like the object's own routes (no team scope). */
export function platformVisible(read: Permission | readonly Permission[]) {
  const needed = Array.isArray(read) ? (read as readonly Permission[]) : [read as Permission];
  return async (_tx: DbOrTx, principal: Principal, _objectId: string): Promise<void> => {
    if (!needed.some((p) => can(principal, p))) throw forbidden(needed.join('|'), `role ${principal.role} cannot read this object`);
  };
}

/** The advisory key every writer of a platform object takes (the descriptor's default lock, `<kind>:<id>`). */
export async function lockPlatformObject(tx: DbOrTx, kind: string, objectId: string): Promise<void> {
  await lockObject(tx, `${kind}:${objectId}`);
}

/**
 * The guard for a direct write to a platform object, inside its transaction: takes the object's lock,
 * refuses while a proposal is open (409 approval_open) and refuses when the write must be a proposal
 * (409 approval_required). An object is governed once approved OR while it is live (platform-live.ts), so a
 * live object without an approval record (upgraded before the grandfather migration) is never a draft.
 * `governed` widens it further for kinds whose liveness their service judges (a model profile a live agent
 * uses; a price the catalog maintains).
 */
export async function assertPlatformWrite(
  tx: DbOrTx,
  kind: string,
  objectId: string,
  action: ApprovalAction = 'UPDATE',
  governed?: (tx: DbOrTx) => Promise<boolean>,
): Promise<void> {
  await lockPlatformObject(tx, kind, objectId);
  await assertUnlocked(tx, { kind }, objectId);
  if (action === 'ACTIVATE' || action === 'DELETE' || (await platformGoverned(tx, kind, objectId)) || (governed ? await governed(tx) : false)) {
    throw approvalRequiredError(kind, objectId, action);
  }
}

/** Approved, or live right now: every change is a proposal. */
export async function platformGoverned(tx: DbOrTx, kind: string, objectId: string): Promise<boolean> {
  return (await isApproved(tx, kind, objectId)) || (await isLivePlatformObject(tx, kind, objectId));
}

/** The descriptors' requiresApproval: ACTIVATE and DELETE always; any other change once governed. */
export function platformRequiresApproval(kind: string) {
  return async (tx: DbOrTx, objectId: string, action: ApprovalAction): Promise<boolean> =>
    action === 'ACTIVATE' || action === 'DELETE' || platformGoverned(tx, kind, objectId);
}

/**
 * requestApproval (approvals/request.ts) for writes that carry secret values: the draft path writes them
 * directly; a proposal first stores them as new secrets (`stage`) and carries only the refs. A submit that
 * fails discards what it staged, so nothing is left behind.
 */
export async function requestStagedApproval<T>(
  approvals: ApprovalService,
  actor: ActorContext,
  target: Omit<ApprovalTarget, 'payload'>,
  approval: ApprovalRequest | undefined,
  direct: (() => Promise<T>) | null,
  stage: () => Promise<{ payload: Record<string, unknown>; discard: () => Promise<void> }>,
): Promise<ApprovalOutcome<T>> {
  const gate = await approvals.gate(actor.principal!, target.objectKind, target.objectId, target.action);
  if (gate.openId) throw approvalOpenError(target.objectKind, target.objectId, gate.openId);
  if (!gate.needed && direct) return { kind: 'applied', value: await direct() };
  if (!approval) throw approvalRequiredError(target.objectKind, target.objectId, target.action);
  const staged = await stage();
  try {
    const proposal = await approvals.submit(actor, ApprovalService.commandFor({ ...target, payload: staged.payload }, approval));
    return { kind: 'proposed', proposal };
  } catch (err) {
    await staged.discard();
    throw err;
  }
}

/** Queue row / email subject in the reference descriptors' wording. */
export function platformTitle(p: ProposalRow, before: Record<string, unknown> | null, o: { noun: string; resumed?: boolean; activateVerb?: string }): string {
  const name = String(before?.['name'] ?? o.noun);
  if (p.action === 'DELETE') return `Delete ${o.noun} ${name}`;
  if (p.action === 'ACTIVATE') return `${o.resumed ? 'Re-enable' : (o.activateVerb ?? 'Activate')} ${o.noun} ${name}`;
  if (p.action === 'CREATE') return `Create ${o.noun} ${name}`;
  return `Change ${o.noun} ${name}: ${describeDiff(diffFields(p.beforeSnapshot, p.afterSnapshot))}`;
}

/** Only the keys the patch sets (undefined = unchanged). */
export function definedOnly<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Credential field names as the checker sees them: what is stored, and what the proposal replaces or removes. */
export function credentialView(stored: readonly string[], change?: { replaced?: readonly string[] | undefined; removed?: readonly string[] | undefined }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of [...new Set([...stored, ...(change?.replaced ?? [])])].sort()) {
    if (change?.removed?.includes(field)) continue;
    out[field] = change?.replaced?.includes(field) ? (stored.includes(field) ? 'new value (proposed)' : 'added (proposed)') : 'stored';
  }
  return out;
}
