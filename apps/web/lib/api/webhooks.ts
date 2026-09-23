import 'server-only';
import { z } from 'zod';
import { ObjectApprovalStateSchema, ProposedSchema } from '@/components/approvals/lib/schemas';
import { api } from './client';

/**
 * Outbound event webhooks (GET/POST /v1/webhooks, packages/application/src/webhooks).
 * The signing secret is returned only by create and rotate, exactly once.
 */
export const WebhookSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  enabled: z.boolean(),
  createdAt: z.string(),
  last24h: z.object({ sent: z.number(), failed: z.number(), pending: z.number() }),
  lastDeliveryAt: z.string().nullable(),
  /** Maker–checker state (PM/research/11 §4). */
  approval: ObjectApprovalStateSchema.nullable().catch(null).default(null),
});
export type Webhook = z.infer<typeof WebhookSchema>;

export const DeliverySchema = z.object({
  id: z.string(),
  eventId: z.string(),
  eventType: z.string(),
  status: z.enum(['PENDING', 'SENT', 'FAILED']),
  attempts: z.number(),
  responseStatus: z.number().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
});
export type Delivery = z.infer<typeof DeliverySchema>;

const SecretOnce = z.object({ signingSecret: z.string() });
const TestSchema = z.object({ ok: z.boolean(), status: z.number().nullable(), error: z.string().nullable() });
export type WebhookTestResult = z.infer<typeof TestSchema>;

export interface WebhookInput {
  name: string;
  url: string;
  events: string[];
}

export const listWebhooks = () => api.get('/v1/webhooks', z.array(WebhookSchema));
export const listWebhookEventTypes = () => api.get('/v1/webhooks/event-types', z.array(z.string()));
export const createWebhook = (input: WebhookInput) => api.post('/v1/webhooks', input, SecretOnce.extend({ id: z.string() }));
/** A draft changes directly (204); an approved subscription answers 409 approval_required until `approval` names a checker (202). */
export const updateWebhook = (id: string, patch: Partial<WebhookInput> & { approval?: { checkerId: string; reason: string } | { bootstrap: true; reason?: string | undefined } | undefined }) =>
  api.patch(`/v1/webhooks/${id}`, patch, z.union([ProposedSchema, z.unknown()]));
export const rotateWebhookSecret = (id: string) => api.post(`/v1/webhooks/${id}/rotate-secret`, undefined, SecretOnce);
export const deleteWebhook = (id: string) => api.command('DELETE', `/v1/webhooks/${id}`);
/** Sends a signed `webhook.test` event to the receiver (network call; allow for its timeout). */
export const testWebhook = (id: string) => api.post(`/v1/webhooks/${id}/test`, undefined, TestSchema, { timeoutMs: 30_000 });
export const listDeliveries = (id: string, status?: Delivery['status']) =>
  api.get(`/v1/webhooks/${id}/deliveries${status ? `?status=${status}` : ''}`, z.array(DeliverySchema));
export const retryDelivery = (deliveryId: string) => api.command('POST', `/v1/webhook-deliveries/${deliveryId}/retry`);
