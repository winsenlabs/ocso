import type { DeliveryStatusUpdate, IdentityUpdate, InboundEnvelope, InboundMessage } from '../../contract/types.js';
import { invalidInbound } from '../../common/errors.js';
import { identityUpdateFromSystemMessage, identityUpdatesFromChange } from './identity-updates.js';
import { normalizeMessage } from './messages.js';
import { MessagesValue, WaMessageBase, WebhookEnvelope } from './schema.js';
import { normalizeStatus } from './statuses.js';

/**
 * Webhook envelope -> InboundEnvelope. Handles batched payloads (many
 * entries, many changes, many messages/statuses each). Call only after
 * `verifyRequest` accepted the signature.
 */

export interface ParseOptions {
  /** When set, entries for other WhatsApp Business Accounts are ignored. */
  businessAccountId?: string | undefined;
  now: () => Date;
}

class EnvelopeBuilder {
  readonly messages: InboundMessage[] = [];
  readonly statuses: DeliveryStatusUpdate[] = [];
  readonly identityUpdates: IdentityUpdate[] = [];
  ignored = 0;

  build(): InboundEnvelope {
    return { messages: this.messages, statuses: this.statuses, identityUpdates: this.identityUpdates, ignored: this.ignored };
  }
}

type ChangeHandler = (value: unknown, out: EnvelopeBuilder, options: ParseOptions) => void;

function handleMessagesChange(value: unknown, out: EnvelopeBuilder, options: ParseOptions): void {
  const parsed = MessagesValue.safeParse(value);
  if (!parsed.success) {
    out.ignored += 1;
    return;
  }
  const { metadata, contacts, messages, statuses, errors } = parsed.data;
  const channelAccountId = metadata.phone_number_id;
  for (const raw of messages) {
    if (WaMessageBase.safeParse(raw).data?.type === 'system') {
      const update = identityUpdateFromSystemMessage(raw, channelAccountId, options.now);
      if (update) out.identityUpdates.push(update);
      else out.ignored += 1;
      continue;
    }
    const message = normalizeMessage(raw, { contacts, channelAccountId, now: options.now });
    if (message) out.messages.push(message);
    else out.ignored += 1;
  }
  for (const raw of statuses) {
    const status = normalizeStatus(raw, options.now);
    if (status) out.statuses.push(status);
    else out.ignored += 1;
  }
  // Webhook-level `errors` (e.g. unsupported content) carry no customer content.
  out.ignored += errors.length;
}

function handleUserIdUpdateChange(value: unknown, out: EnvelopeBuilder, options: ParseOptions): void {
  const updates = identityUpdatesFromChange(value, options.now);
  if (updates?.length) out.identityUpdates.push(...updates);
  else out.ignored += 1;
}

const CHANGE_HANDLERS: ReadonlyMap<string, ChangeHandler> = new Map<string, ChangeHandler>([
  ['messages', handleMessagesChange],
  ['user_id_update', handleUserIdUpdateChange],
]);

function parseJson(rawBody: Buffer | null): unknown {
  if (rawBody === null || rawBody.byteLength === 0) throw invalidInbound('whatsapp_empty_body', 'webhook body is empty');
  try {
    return JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw invalidInbound('whatsapp_invalid_json', 'webhook body is not valid JSON');
  }
}

export function parseWhatsAppWebhook(rawBody: Buffer | null, options: ParseOptions): InboundEnvelope {
  const envelope = WebhookEnvelope.safeParse(parseJson(rawBody));
  if (!envelope.success) throw invalidInbound('whatsapp_invalid_envelope', 'webhook body is not a WhatsApp envelope');
  const out = new EnvelopeBuilder();
  if (envelope.data.object !== 'whatsapp_business_account') {
    out.ignored += 1;
    return out.build();
  }
  for (const entry of envelope.data.entry) {
    if (options.businessAccountId && entry.id !== options.businessAccountId) {
      out.ignored += Math.max(1, entry.changes.length);
      continue;
    }
    for (const change of entry.changes) {
      const handle = CHANGE_HANDLERS.get(change.field);
      if (handle) handle(change.value, out, options);
      else out.ignored += 1;
    }
  }
  return out.build();
}
