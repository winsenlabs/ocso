'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Permission } from '@ocso/auth';
import { describeApiError } from '../api/errors';
import { acknowledgeChainBreak, verifyRecentAuditChain, type AuditVerification } from '../api/audit-store';
import { getSession } from '../session';

export type VerifyState = { status: 'idle' } | { status: 'done'; result: AuditVerification } | { status: 'error'; message: string };

/** POST /v1/audit/verify for the latest entries (audit.verify); the API records who verified what. */
export async function verifyAuditChainAction(): Promise<VerifyState> {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.permissions.has(Permission.AUDIT_VERIFY)) return { status: 'error', message: 'Verifying the audit chain needs the audit.verify permission.' };
  try {
    return { status: 'done', result: await verifyRecentAuditChain() };
  } catch (err) {
    return { status: 'error', message: describeApiError(err) };
  }
}

export type AcknowledgeState = { status: 'idle' } | { status: 'done' } | { status: 'error'; message: string };

/** POST /v1/audit/incidents/:id/acknowledge (audit.verify): the break stays recorded; the incident closes with the note. */
export async function acknowledgeChainBreakAction(incidentId: string, note: string): Promise<AcknowledgeState> {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.permissions.has(Permission.AUDIT_VERIFY)) return { status: 'error', message: 'Acknowledging a chain break needs the audit.verify permission.' };
  if (note.trim().length < 10) return { status: 'error', message: 'Say what was investigated (at least 10 characters).' };
  try {
    await acknowledgeChainBreak(incidentId, note.trim());
    revalidatePath('/system');
    return { status: 'done' };
  } catch (err) {
    return { status: 'error', message: describeApiError(err) };
  }
}
