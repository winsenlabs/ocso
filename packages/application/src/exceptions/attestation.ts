import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@ocso/db';
import type { ExceptionReportContent } from './contract.js';

/**
 * What a signer must acknowledge before signing (ADR-033, segregation of
 * duties): the flags go into the signed message, the sign-off audit row, the
 * screen and the export, so an auditor sees a self-attested or partial report
 * for what it is.
 *
 *   self_attested    the signer did or is the subject of a critical/high item (a bootstrap self-approval, a
 *                    bypass of their own access), or their own access was approved under the bootstrap rule
 *   failed_checks    at least one check failed and its section is empty
 *   truncated        a section lists fewer items than it counted
 *   incomplete_data  a check's period starts before the history it reads is retained
 */
export const ATTESTATION_FLAGS = ['self_attested', 'failed_checks', 'truncated', 'incomplete_data'] as const;
export type AttestationFlag = (typeof ATTESTATION_FLAGS)[number];

export const ATTESTATION_TEXT: Record<AttestationFlag, string> = {
  self_attested: 'I am named in this report’s critical or high items, or my own access was self-approved: this sign-off is self-attested.',
  failed_checks: 'Some checks failed and report nothing: I sign knowing they were not run.',
  truncated: 'Some sections list fewer items than they counted.',
  incomplete_data: 'Some checks cover a period older than the history they read: their sections may be incomplete.',
};

/** Whether this user's own access (a user or permission change about them) was approved under the bootstrap rule. */
export async function accessSelfApproved(db: DbOrTx, userId: string): Promise<boolean> {
  const { rows } = await db.execute<{ one: number }>(
    sql`SELECT 1 AS one FROM approval_decisions d JOIN approval_proposals p ON p.id = d.proposal_id
         WHERE d.kind = 'BOOTSTRAP_APPROVE' AND p.object_id = ${userId}::uuid LIMIT 1`,
  );
  return rows.length > 0;
}

export function requiredAttestation(content: ExceptionReportContent, signerId: string, selfApprovedAccess: boolean): AttestationFlag[] {
  const flags: AttestationFlag[] = [];
  const named = content.sections
    .filter((s) => s.severity === 'critical' || s.severity === 'high')
    .some((s) => s.items.some((i) => (i.actorIds ?? []).includes(signerId) || (i.subjectIds ?? []).includes(signerId)));
  if (named || selfApprovedAccess) flags.push('self_attested');
  if (content.totals.failedChecks > 0) flags.push('failed_checks');
  if (content.sections.some((s) => s.truncated)) flags.push('truncated');
  if (content.sections.some((s) => s.coverage && !s.coverage.complete)) flags.push('incomplete_data');
  return flags;
}
