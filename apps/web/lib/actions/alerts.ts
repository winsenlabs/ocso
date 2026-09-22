'use server';

import { refresh } from 'next/cache';
import { Permission } from '@ocso/auth';
import { z } from 'zod';
import {
  ALERT_KINDS,
  ALERT_SEVERITIES,
  AUDIENCE_ROLES,
  DESTINATION_KINDS,
  acknowledgeAlert,
  createAlertRule,
  createDestination,
  deleteAlertRule,
  deleteDestination,
  resolveAlert,
  testDestination,
  updateAlertRule,
  updateDestination,
  type DestinationTestResult,
} from '../api/alerts';
import { describeApiError } from '../api/errors';
import { getSession } from '../session';

/** Result of an alerts-screen server action (called from client components). */
export type AlertActionResult<T = null> = { ok: true; data: T } | { ok: false; message: string };

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
    return { ok: false, message: describeApiError(err) };
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

const RuleInput = z.object({
  name: z.string().trim().min(1, 'Enter a rule name').max(160),
  kind: z.enum(ALERT_KINDS),
  condition: z.string().trim().min(1, 'Choose a condition').max(64),
  params: z.record(z.string(), z.unknown()),
  windowSeconds: z.number().int(),
  severity: z.enum(ALERT_SEVERITIES),
  audienceRoles: z.array(z.enum(AUDIENCE_ROLES)).min(1, 'Choose at least one audience role'),
  destinationIds: z.array(Id),
  dedupeWindowSeconds: z.number().int(),
  autoResolve: z.boolean(),
  enabled: z.boolean(),
});
export type RuleFormInput = z.infer<typeof RuleInput>;

export async function createAlertRuleAction(input: RuleFormInput): Promise<AlertActionResult<{ id: string }>> {
  return run(RuleInput, input, async (i) => ({ id: (await createAlertRule(i)).id }));
}

export async function updateAlertRuleAction(id: string, input: RuleFormInput): Promise<AlertActionResult> {
  return run(z.object({ id: Id, body: RuleInput }), { id, body: input }, async (i) => {
    await updateAlertRule(i.id, i.body);
    return null;
  });
}

export async function setAlertRuleEnabledAction(id: string, enabled: boolean): Promise<AlertActionResult> {
  return run(z.object({ id: Id, enabled: z.boolean() }), { id, enabled }, async (i) => {
    await updateAlertRule(i.id, { enabled: i.enabled });
    return null;
  });
}

export async function deleteAlertRuleAction(id: string): Promise<AlertActionResult> {
  return run(Id, id, async (ruleId) => {
    await deleteAlertRule(ruleId);
    return null;
  });
}

const DestinationBody = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(120),
  config: z.record(z.string(), z.unknown()),
  secret: z.string().max(4096).optional(),
  enabled: z.boolean(),
});

export async function createDestinationAction(input: z.input<typeof DestinationBody> & { kind: string }): Promise<AlertActionResult<{ id: string }>> {
  return run(
    DestinationBody.extend({ kind: z.enum(DESTINATION_KINDS) }),
    input,
    async (i) => ({ id: (await createDestination({ name: i.name, kind: i.kind, config: i.config, enabled: i.enabled, ...(i.secret ? { secret: i.secret } : {}) })).id }),
    Permission.NOTIFICATION_DESTINATIONS_MANAGE,
  );
}

export async function updateDestinationAction(id: string, input: z.input<typeof DestinationBody>): Promise<AlertActionResult> {
  return run(
    z.object({ id: Id, body: DestinationBody }),
    { id, body: input },
    async ({ id: destinationId, body }) => {
      const { secret, ...rest } = body;
      await updateDestination(destinationId, secret ? { ...rest, secret } : rest);
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
