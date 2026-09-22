'use server';

import { refresh } from 'next/cache';
import { Permission } from '@ocso/auth';
import { z } from 'zod';
import { describeApiError } from '../api/errors';
import { createWebhook, deleteWebhook, retryDelivery, rotateWebhookSecret, testWebhook, updateWebhook, type WebhookTestResult } from '../api/webhooks';
import { getSession } from '../session';
import type { ActionResult } from './models';

const Id = z.uuid();
const Input = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(80),
  url: z.url({ protocol: /^https$/, error: 'Enter an https:// URL' }).max(2_000),
  events: z.array(z.string().trim().min(1).max(80)).min(1, 'Choose at least one event').max(40),
});

async function run<I, T>(schema: z.ZodType<I>, raw: unknown, call: (input: I) => Promise<T>, reload = true): Promise<ActionResult<T>> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => i.message).join('; ') };
  const session = await getSession();
  if (!session) return { ok: false, message: 'Your session has ended. Sign in again.' };
  if (!session.permissions.has(Permission.WEBHOOKS_MANAGE)) return { ok: false, message: 'Your role cannot manage webhooks.' };
  try {
    const data = await call(parsed.data);
    if (reload) refresh();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, message: describeApiError(err) };
  }
}

/** Creates the subscription; the signing secret comes back once and is never readable again. */
export async function createWebhookAction(input: z.input<typeof Input>): Promise<ActionResult<{ id: string; signingSecret: string }>> {
  return run(Input, input, createWebhook, false);
}

export async function updateWebhookAction(id: string, input: z.input<typeof Input> & { enabled: boolean }): Promise<ActionResult> {
  return run(z.object({ id: Id, body: Input.extend({ enabled: z.boolean() }) }), { id, body: input }, async (i) => {
    await updateWebhook(i.id, i.body);
    return null;
  });
}

export async function rotateWebhookSecretAction(id: string): Promise<ActionResult<{ signingSecret: string }>> {
  return run(Id, id, rotateWebhookSecret, false);
}

export async function deleteWebhookAction(id: string): Promise<ActionResult> {
  return run(Id, id, async (wid) => {
    await deleteWebhook(wid);
    return null;
  });
}

export async function testWebhookAction(id: string): Promise<ActionResult<WebhookTestResult>> {
  return run(Id, id, testWebhook);
}

export async function retryDeliveryAction(deliveryId: string): Promise<ActionResult> {
  return run(Id, deliveryId, async (did) => {
    await retryDelivery(did);
    return null;
  });
}

/** Closing the one-time secret view re-renders the list with the new subscription. */
export async function refreshWebhooksAction(): Promise<ActionResult> {
  return run(z.null(), null, async () => null);
}
