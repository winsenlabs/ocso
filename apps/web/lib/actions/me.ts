'use server';

import { z } from 'zod';
import { AVAILABILITY, setMyAvailability } from '../api/users';
import { describeApiError } from '../api/errors';
import { getSession } from '../session';

export type AvailabilityResult = { ok: true; availability: (typeof AVAILABILITY)[number] } | { ok: false; message: string };

/** PUT /v1/me/availability — the signed-in user's own availability for assignment. */
export async function setAvailabilityAction(value: string): Promise<AvailabilityResult> {
  const parsed = z.enum(AVAILABILITY).safeParse(value);
  if (!parsed.success) return { ok: false, message: 'Unknown availability' };
  if (!(await getSession())) return { ok: false, message: 'Your session has ended. Sign in again.' };
  try {
    await setMyAvailability(parsed.data);
    return { ok: true, availability: parsed.data };
  } catch (err) {
    return { ok: false, message: describeApiError(err) };
  }
}
