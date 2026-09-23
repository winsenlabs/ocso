'use server';

import { refresh } from 'next/cache';
import { Permission } from '@ocso/auth';
import { z } from 'zod';
import {
  acknowledgeAlert,
  createDestination,
  deleteDestination,
  resolveAlert,
  testDestination,
  updateDestination,
  type DestinationTestResult,
} from '../api/alerts';
import { ApiError, describeApiError } from '../api/errors';
import { getSession } from '../session';

/** Result of an alerts-screen server action (called from client components). */
export type AlertActionResult<T = null> = { ok: true; data: T } | { ok: false; message: string; code?: string | undefined };

const Id = z.uuid();

/**
 * Validate the input shape, require a session (and optionally a permission),
 * call the API, refresh the page on success. The API stays the enforcement
 * point: kind-specific rule permissions are checked there.
 */
async function run<I, T>(schema: z.ZodType<I>, raw: unknown, call: (input: I) => Promise<T>, permission?: Permission): Promise<AlertActionResult<T>> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ') };
  const session = await getSession();
  if (!session) return { ok: false, message: 'Your session has ended. Sign in again.' };
  if (permission && !session.permissions.has(permission)) return { ok: false, message: 'Your role cannot do this.' };
  try {
    const data = await call(parsed.data);
    refresh();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, message: describeApiError(err), code: err instanceof ApiError ? err.code : undefined };
  }
}

const Note = z.string().trim().max(2000);

export async function acknowledgeAlertAction(id: string, note: string): Promise<AlertActionResult> {
  return run(
    z.object({ id: Id, note: Note }),
    { id, note },
    async (i) => {
      await acknowledgeAlert(i.id, i.note || undefined);
      return null;
    },
    Permission.ALERTS_ACKNOWLEDGE,
  );
}

export async function resolveAlertAction(id: string, note: string): Promise<AlertActionResult> {
  return run(
    z.object({ id: Id, note: Note.min(1, 'A resolution note is required') }),
    { id, note },
    async (i) => {
      await resolveAlert(i.id, i.note);
      return null;
    },
    Permission.ALERTS_ACKNOWLEDGE,
  );
}

// Alert rules (maker–checker): lib/actions/alert-rules.ts.

const DestinationBody = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(120),
  config: z.record(z.string(), z.unknown()),
  secret: z.string().max(4096).optional(),
  /** Ignored: a new destination is a disabled draft; enabling is a proposal (Activate on its row). */
  enabled: z.boolean().optional(),
});
const DestinationApproval = z.union([z.object({ checkerId: Id, reason: z.string().trim().min(3).max(500) }), z.object({ bootstrap: z.literal(true), reason: z.string().trim().min(3).max(500).optional() })]);

export async function createDestinationAction(input: z.input<typeof DestinationBody> & { kind: string }): Promise<AlertActionResult<{ id: string }>> {
  return run(
    // Kinds are open; the API checks the kind against the delivery registry.
    DestinationBody.extend({ kind: z.string().trim().min(1, 'Choose a type').max(40) }),
    input,
    async (i) => ({ id: (await createDestination({ name: i.name, kind: i.kind, config: i.config, enabled: false, ...(i.secret ? { secret: i.secret } : {}) })).id }),
    Permission.NOTIFICATION_DESTINATIONS_MANAGE,
  );
}

/** A draft changes directly; an approved destination needs `approval` (then it is a proposal; the secret travels as a ref). */
export async function updateDestinationAction(id: string, input: z.input<typeof DestinationBody>, approval?: z.input<typeof DestinationApproval>): Promise<AlertActionResult> {
  return run(
    z.object({ id: Id, body: DestinationBody, approval: DestinationApproval.optional() }),
    { id, body: input, approval },
    async ({ id: destinationId, body, approval: a }) => {
      const { secret, enabled: _enabled, ...rest } = body;
      await updateDestination(destinationId, { ...rest, ...(secret ? { secret } : {}), ...(a ? { approval: a } : {}) });
      return null;
    },
    Permission.NOTIFICATION_DESTINATIONS_MANAGE,
  );
}

export async function deleteDestinationAction(id: string): Promise<AlertActionResult> {
  return run(
    Id,
    id,
    async (destinationId) => {
      await deleteDestination(destinationId);
      return null;
    },
    Permission.NOTIFICATION_DESTINATIONS_MANAGE,
  );
}

export async function testDestinationAction(id: string): Promise<AlertActionResult<DestinationTestResult>> {
  return run(Id, id, testDestination, Permission.NOTIFICATION_DESTINATIONS_MANAGE);
}
