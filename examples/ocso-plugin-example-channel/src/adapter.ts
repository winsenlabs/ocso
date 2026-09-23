import { randomUUID } from 'node:crypto';
import {
  pluginError,
  type ChannelAdapter,
  type ChannelAdapterDeps,
  type ChannelCapabilities,
  type ChannelKindDescriptor,
  type ChannelRuntimeConfig,
  type DeliveryStatus,
  type DeliveryStatusUpdate,
  type InboundEnvelope,
  type InboundMessage,
  type InteractionPart,
  type RawHttpRequest,
  type RenderedOutbound,
  type SendResult,
  type VerificationResult,
} from '@winsendotai/ocso-plugin-sdk';
import { SIGNATURE_HEADER, sign, signatureMatches } from './signature.js';

/**
 * A generic JSON-webhook channel: any system that can POST signed JSON can
 * talk to OCSO through it.
 *
 * Inbound (your system → OCSO): `POST /channels/json-webhook/<publicKey>/webhook`
 * with `x-ocso-signature: sha256=<hex HMAC-SHA256(body, signingSecret)>` and
 * `{ "messages": [{ "id", "from", "text", "name"?, "sentAt"? }], "statuses": [{ "id", "status", "at"? }] }`.
 *
 * Outbound (OCSO → your system): `POST <outboundUrl>`, signed the same way,
 * with `{ "id", "to", "text" }`. A 2xx answer means accepted.
 */

export const KIND = 'JSON_WEBHOOK';
export const IDENTITY_KIND = 'json_webhook_user';
const MAX_TEXT = 4_000;
const STATUS: Readonly<Record<string, DeliveryStatus>> = { sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' };

const DESCRIPTOR: ChannelKindDescriptor = {
  kind: KIND,
  label: 'JSON webhook (example)',
  description: 'Exchange messages with any system that can send and receive signed JSON over HTTPS.',
  mark: { code: 'JS', name: 'JSON webhook' },
  settingsSchema: {
    type: 'object',
    properties: { outboundUrl: { type: 'string', title: 'Outbound URL', description: 'HTTPS endpoint OCSO posts replies to.' } },
    required: ['outboundUrl'],
  },
  secrets: [{ key: 'signingSecret', label: 'Signing secret', required: true, hint: 'Shared HMAC-SHA256 key, at least 16 characters.', generate: 'client' }],
  identitySetting: { label: 'Outbound URL', keys: ['outboundUrl'] },
  setupSteps: [
    'Give your system the webhook URL below and the signing secret.',
    'Sign every request body with HMAC-SHA256 and send it as x-ocso-signature: sha256=<hex>.',
    'Verify the same header on the replies OCSO posts to your outbound URL.',
  ],
  inboundWebhook: true,
  webhookEvents: 'messages, delivery statuses',
  embeddable: false,
};

const CAPABILITIES: ChannelCapabilities = {
  inboundParts: ['TEXT'],
  outboundParts: ['TEXT', 'STRUCTURED'],
  maxTextLength: MAX_TEXT,
  markdown: 'none',
  streaming: false,
  deliveryReceipts: true,
  interactive: false,
  maxMediaBytes: { IMAGE: 0, AUDIO: 0, VIDEO: 0, DOCUMENT: 0 },
  allowedMimeTypes: { IMAGE: [], AUDIO: [], VIDEO: [], DOCUMENT: [] },
  sessionWindowHours: null,
  identityKinds: [IDENTITY_KIND],
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

function secretOf(config: ChannelRuntimeConfig): string {
  const secret = config.secrets['signingSecret'];
  if (!secret) throw pluginError('validation', 'json_webhook_not_configured', 'The signing secret is missing');
  return secret;
}

function invalid(message: string): Error {
  return pluginError('validation', 'json_webhook_payload_invalid', message);
}

function parseMessage(raw: unknown, receivedAt: Date): InboundMessage {
  if (!isRecord(raw)) throw invalid('Each message must be an object');
  const id = text(raw['id']);
  const from = text(raw['from']);
  const body = text(raw['text']);
  if (!id || !from || !body) throw invalid('A message needs id, from and text');
  const sentAt = typeof raw['sentAt'] === 'string' ? new Date(raw['sentAt']) : receivedAt;
  const name = text(raw['name']);
  return {
    externalMessageId: id,
    identityKind: IDENTITY_KIND,
    identityValue: from,
    alternateIdentities: [],
    ...(name ? { profileName: name } : {}),
    receivedAt: Number.isNaN(sentAt.getTime()) ? receivedAt : sentAt,
    parts: [{ type: 'TEXT', text: body.slice(0, 32_000) }],
  };
}

function parseStatus(raw: unknown, now: Date): DeliveryStatusUpdate | null {
  if (!isRecord(raw)) return null;
  const id = text(raw['id']);
  const status = typeof raw['status'] === 'string' ? STATUS[raw['status']] : undefined;
  if (!id || !status) return null;
  const at = typeof raw['at'] === 'string' ? new Date(raw['at']) : now;
  return { externalMessageId: id, status, occurredAt: Number.isNaN(at.getTime()) ? now : at };
}

/** Plain text a part carries on this channel (choice questions arrive with their numbered fallback). */
function plainText(part: InteractionPart): string | null {
  if (part.type === 'TEXT') return part.text;
  if (part.type === 'STRUCTURED') return part.fallbackText ?? null;
  return null;
}

export function createJsonWebhookAdapter(deps: ChannelAdapterDeps): ChannelAdapter {
  return {
    kind: KIND,
    describe: () => DESCRIPTOR,
    capabilities: () => CAPABILITIES,
    displayIdentity: (identityKind, value) => (identityKind === IDENTITY_KIND ? value : null),

    validateConfig(settings, secrets) {
      const problems: string[] = [];
      const url = isRecord(settings) ? settings['outboundUrl'] : undefined;
      if (typeof url !== 'string' || !URL.canParse(url) || new URL(url).protocol !== 'https:') problems.push('Outbound URL must be an https:// URL');
      if ((secrets['signingSecret'] ?? '').length < 16) problems.push('Signing secret must be at least 16 characters');
      return problems;
    },

    verifyRequest(req: RawHttpRequest, config): VerificationResult {
      if (req.method !== 'POST' || !req.rawBody) return { kind: 'rejected', status: 400, reason: 'expected a signed JSON POST' };
      return signatureMatches(secretOf(config), req.rawBody, req.headers[SIGNATURE_HEADER])
        ? { kind: 'verified' }
        : { kind: 'rejected', status: 401, reason: 'signature mismatch' };
    },

    parseInbound(req: RawHttpRequest): InboundEnvelope {
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(req.rawBody ?? new Uint8Array()));
      } catch {
        throw invalid('The body is not JSON');
      }
      if (!isRecord(body)) throw invalid('The body must be a JSON object');
      const now = deps.now();
      const messages = Array.isArray(body['messages']) ? body['messages'].map((m) => parseMessage(m, now)) : [];
      const rawStatuses = Array.isArray(body['statuses']) ? body['statuses'] : [];
      const statuses = rawStatuses.map((s) => parseStatus(s, now)).filter((s): s is DeliveryStatusUpdate => s !== null);
      return { messages, statuses, ignored: rawStatuses.length - statuses.length };
    },

    fetchMedia() {
      return Promise.reject(pluginError('validation', 'json_webhook_media_unsupported', 'This channel carries text only'));
    },

    render(parts, _config): RenderedOutbound[] {
      const out: RenderedOutbound[] = [];
      parts.forEach((part, index) => {
        const value = plainText(part);
        for (let at = 0; value && at < value.length; at += MAX_TEXT) {
          out.push({ kind: KIND, payload: { type: 'text', text: value.slice(at, at + MAX_TEXT) }, partIndexes: [index] });
        }
      });
      return out;
    },

    async send(target, message, config): Promise<SendResult> {
      const url = config.settings['outboundUrl'];
      if (typeof url !== 'string') return { ok: false, errorCode: 'not_configured', message: 'Outbound URL is missing', retriable: false };
      const id = randomUUID();
      const body = JSON.stringify({ id, to: target.identityValue, text: message.payload['text'] });
      let response: Response;
      try {
        response = await deps.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: sign(secretOf(config), body) },
          body,
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        return { ok: false, errorCode: 'network', message: 'The outbound URL could not be reached', retriable: true };
      }
      if (response.ok) return { ok: true, externalMessageId: id };
      const retriable = response.status === 429 || response.status >= 500;
      return { ok: false, errorCode: `http_${response.status}`, message: `The outbound URL answered ${response.status}`, retriable };
    },
  };
}
