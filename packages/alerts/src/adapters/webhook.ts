import { z } from 'zod';
import { checkConfig, httpsUrlProblems } from '../config-check.js';
import type { AlertDeliveryAdapter, AlertEvent, AlertMessage } from '../contract.js';
import { postJson, resultFromHttp } from '../http.js';
import { SIGNATURE_HEADER, signatureHeader } from '../signing.js';
import type { DeliveryAdapterDeps } from './deps.js';

const WebhookConfig = z
  .object({
    url: z
      .string()
      .max(2048)
      .superRefine((value, ctx) => {
        for (const problem of httpsUrlProblems(value, 'url')) ctx.addIssue({ code: 'custom', message: problem });
      })
      .meta({ title: 'Endpoint URL', description: 'https only' }),
  })
  .strict();
export type WebhookConfig = z.infer<typeof WebhookConfig>;

export const WEBHOOK_EVENT_TYPES: Readonly<Record<AlertEvent, string>> = {
  OPENED: 'alert.opened',
  ACKNOWLEDGED: 'alert.acknowledged',
  RESOLVED: 'alert.resolved',
  REMINDER: 'alert.reminder',
};

/** Versioned JSON envelope POSTed to generic webhooks. */
export interface WebhookEnvelope {
  type: string;
  version: 1;
  deliveryId: string;
  occurredAt: string;
  deployment: string | null;
  alert: Omit<AlertMessage, 'deliveryId' | 'event' | 'deployment'>;
}

/**
 * Generic signed webhook. Receivers verify `X-OCSO-Signature: t=<ts>,v1=<hex>`
 * = HMAC-SHA256(secret, `${ts}.${rawBody}`) and de-duplicate on `X-OCSO-Delivery`.
 */
export function createWebhookAdapter(deps: Pick<DeliveryAdapterDeps, 'fetch' | 'timeoutMs' | 'now'>): AlertDeliveryAdapter<WebhookConfig> {
  const now = deps.now ?? (() => new Date());
  return {
    kind: 'WEBHOOK',
    label: 'Webhook (HMAC-signed)',
    description: 'POSTs a versioned JSON envelope signed with HMAC-SHA256 (X-OCSO-Signature) to your endpoint.',
    events: ['OPENED', 'ACKNOWLEDGED', 'RESOLVED', 'REMINDER'],
    configSchema: z.toJSONSchema(WebhookConfig, { io: 'input' }) as Record<string, unknown>,
    secret: { required: true, secretKind: 'WEBHOOK_SECRET', label: 'Signing secret', description: 'HMAC-SHA256 signing secret' },
    validateConfig: (config) => checkConfig(WebhookConfig, config),
    validateSecret: (secret) => (secret.length >= 16 ? [] : ['signing secret must be at least 16 characters']),
    summary: (config) => config.url,
    async deliver(message, config, secret) {
      if (!secret) return { ok: false, retriable: false, error: 'signing secret not configured' };
      const at = now();
      const body = JSON.stringify(buildWebhookEnvelope(message, at));
      const outcome = await postJson(deps.fetch, {
        url: config.url,
        body,
        timeoutMs: deps.timeoutMs,
        headers: {
          [SIGNATURE_HEADER]: signatureHeader(secret, body, Math.floor(at.getTime() / 1000)),
          'X-OCSO-Event': WEBHOOK_EVENT_TYPES[message.event],
          'X-OCSO-Delivery': message.deliveryId,
        },
      });
      // Receiver bodies are arbitrary; only the status code is reported.
      return resultFromHttp(outcome);
    },
  };
}

export function buildWebhookEnvelope(message: AlertMessage, at: Date): WebhookEnvelope {
  const { deliveryId, event, deployment, ...alert } = message;
  return { type: WEBHOOK_EVENT_TYPES[event], version: 1, deliveryId, occurredAt: at.toISOString(), deployment, alert };
}
