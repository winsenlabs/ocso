'use server';

import { refresh } from 'next/cache';
import { Permission } from '@ocso/auth';
import { describeApiError } from '../api/errors';
import { rotateSigningKey } from '../api/secrets';
import { getSession } from '../session';
import type { ActionResult } from './models';

/** Rotates the customer-claims signing key (the old key keeps verifying while it retires). */
export async function rotateSigningKeyAction(): Promise<ActionResult<{ kid: string }>> {
  const session = await getSession();
  if (!session) return { ok: false, message: 'Your session has ended. Sign in again.' };
  if (!session.permissions.has(Permission.SYSTEM_CONFIGURE)) return { ok: false, message: 'Your role cannot rotate signing keys.' };
  try {
    const data = await rotateSigningKey();
    refresh();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, message: describeApiError(err) };
  }
}
