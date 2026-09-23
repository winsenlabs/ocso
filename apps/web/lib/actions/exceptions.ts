'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Permission } from '@ocso/auth';
import { describeApiError } from '../api/errors';
import { createAdhocExceptionReport, regenerateExceptionReport, signExceptionReport } from '../api/exceptions';
import { getSession } from '../session';

export type SignState = { status: 'idle' } | { status: 'done' } | { status: 'error'; message: string };

/** POST /v1/exceptions/reports/:id/sign (exceptions.sign) over the content hash the signer was shown; audited. */
export async function signExceptionReportAction(id: string, contentHash: string, note: string, acknowledge: string[]): Promise<SignState> {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.permissions.has(Permission.EXCEPTIONS_SIGN)) return { status: 'error', message: 'Signing the exception report needs the exceptions.sign permission.' };
  try {
    await signExceptionReport(id, { contentHash, note: note.trim() || undefined, acknowledge });
    revalidatePath('/exceptions');
    revalidatePath(`/exceptions/reports/${id}`);
    return { status: 'done' };
  } catch (err) {
    return { status: 'error', message: describeApiError(err) };
  }
}

export type AdhocState = { status: 'idle' } | { status: 'error'; message: string };

/** POST /v1/exceptions/reports (exceptions.sign): freezes a past period as a draft report, then opens it. */
export async function createAdhocReportAction(periodStart: string, periodEnd: string): Promise<AdhocState> {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.permissions.has(Permission.EXCEPTIONS_SIGN)) return { status: 'error', message: 'Creating a report needs the exceptions.sign permission.' };
  let id: string;
  try {
    id = (await createAdhocExceptionReport({ periodStart, periodEnd })).id;
  } catch (err) {
    return { status: 'error', message: describeApiError(err) };
  }
  revalidatePath('/exceptions');
  redirect(`/exceptions/reports/${id}`);
}

export type RegenerateState = { status: 'idle' } | { status: 'error'; message: string };

/** POST /v1/exceptions/reports/:id/regenerate (exceptions.sign): replaces an unsigned report, then opens the new one. */
export async function regenerateReportAction(id: string, reason: string): Promise<RegenerateState> {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.permissions.has(Permission.EXCEPTIONS_SIGN)) return { status: 'error', message: 'Regenerating a report needs the exceptions.sign permission.' };
  let next: string;
  try {
    next = (await regenerateExceptionReport(id, { reason })).id;
  } catch (err) {
    return { status: 'error', message: describeApiError(err) };
  }
  revalidatePath('/exceptions');
  redirect(`/exceptions/reports/${next}`);
}
