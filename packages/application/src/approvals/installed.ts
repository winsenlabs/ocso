import { approvalProposals, uuidv7, type DbOrTx } from '@ocso/db';

/**
 * Configuration OCSO installs itself before anyone could check it — the first
 * Tech admin created by setup, the default alert rules — is recorded exactly as
 * the grandfather migration records live configuration that predates
 * maker–checker (0031): one APPROVED proposal with origin MIGRATION, no maker,
 * no checker, `activated_at` set. It is never a user approval, the exception
 * report can tell it apart, and every later change to the object is a proposal.
 */
export async function recordInstalledApproval(
  tx: DbOrTx,
  object: { kind: string; id: string; title: string; teamIds?: readonly string[] | undefined },
  reason = 'Installed by OCSO at setup, before anyone could check it',
): Promise<void> {
  const now = new Date();
  await tx.insert(approvalProposals).values({
    id: uuidv7(),
    objectKind: object.kind,
    objectId: object.id,
    action: 'CREATE',
    status: 'APPROVED',
    origin: 'MIGRATION',
    payload: {},
    contentHash: 'ap_installed',
    dependencyHash: 'ad_installed',
    teamIds: [...(object.teamIds ?? [])],
    title: object.title,
    reason,
    submittedAt: now,
    decidedAt: now,
    decisionReason: 'Installed at setup',
    activatedAt: now,
  });
}
