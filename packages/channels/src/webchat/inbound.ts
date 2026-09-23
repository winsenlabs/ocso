import { z } from 'zod';
import { InteractionPart } from '@ocso/domain';
import type { ChannelCapabilities, InboundEnvelope, InboundMessage } from '../contract/types.js';
import { invalidInbound } from '../common/errors.js';
import { attachmentKeyPrefix, attachmentToPart, WebChatAttachment } from './attachments.js';
import type { ResolvedWebChatConfig } from './config.js';
import { identityDigest, type WebChatIdentity } from './identity.js';

/**
 * Widget message body, POSTed as JSON through the OCSO API:
 * `{ clientMessageId, text?, attachments?, structured?, replyToExternalId? }`.
 * `clientMessageId` is the widget-generated idempotency key; it is namespaced
 * by the sender's identity so two visitors can never collide (or pre-claim
 * each other's keys). Server time is used; client clocks are not trusted.
 */

const MAX_BODY_BYTES = 256 * 1024;

export const WebChatInboundBody = z.object({
  clientMessageId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/, 'must be 8-128 url-safe characters'),
  text: z.string().optional(),
  attachments: z.array(WebChatAttachment).max(10).default([]),
  structured: z
    .object({
      schema: z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/, 'invalid structured schema name'),
      data: z.record(z.string(), z.unknown()),
      fallbackText: z.string().max(4_000).optional(),
    })
    .optional(),
  replyToExternalId: z.string().min(1).max(256).optional(),
});
export type WebChatInboundBody = z.infer<typeof WebChatInboundBody>;

export interface WebChatParseContext {
  config: ResolvedWebChatConfig;
  capabilities: ChannelCapabilities;
  identity: WebChatIdentity;
  now: Date;
}

function parseBody(rawBody: Buffer | null): WebChatInboundBody {
  if (!rawBody?.byteLength) throw invalidInbound('webchat_empty_body', 'message body is empty');
  if (rawBody.byteLength > MAX_BODY_BYTES) throw invalidInbound('webchat_body_too_large', 'message body is too large');
  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw invalidInbound('webchat_invalid_json', 'message body is not valid JSON');
  }
  const parsed = WebChatInboundBody.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`);
    throw invalidInbound('webchat_invalid_message', `invalid web chat message: ${problems.join('; ')}`, { problems });
  }
  return parsed.data;
}

function textPart(text: string | undefined, limit: number): InteractionPart[] {
  if (!text?.trim()) return [];
  if (text.length > limit) throw invalidInbound('webchat_text_too_long', `text exceeds ${limit} characters`);
  return [{ type: 'TEXT', text }];
}

function structuredPart(structured: WebChatInboundBody['structured']): InteractionPart[] {
  if (!structured) return [];
  const parsed = InteractionPart.safeParse({ type: 'STRUCTURED', ...structured });
  if (!parsed.success) throw invalidInbound('webchat_invalid_structured', 'structured payload is invalid');
  return [parsed.data];
}

export function parseWebChatInbound(rawBody: Buffer | null, ctx: WebChatParseContext): InboundEnvelope {
  const body = parseBody(rawBody);
  const { capabilities, config, identity } = ctx;
  if (body.attachments.length > config.settings.maxAttachmentsPerMessage) {
    throw invalidInbound('webchat_too_many_attachments', `at most ${config.settings.maxAttachmentsPerMessage} attachments`);
  }
  const keyPrefix = attachmentKeyPrefix(config.channelId, identity);
  const parts: InteractionPart[] = [
    ...textPart(body.text, capabilities.maxTextLength),
    ...body.attachments.map((attachment) => attachmentToPart(attachment, { capabilities, keyPrefix })),
    ...structuredPart(body.structured),
  ];
  if (!parts.length) throw invalidInbound('webchat_empty_message', 'message has no text, attachments or structured data');
  const message: InboundMessage = {
    externalMessageId: `webchat:${identityDigest(identity)}:${body.clientMessageId}`,
    identityKind: identity.identityKind,
    identityValue: identity.identityValue,
    alternateIdentities: identity.alternateIdentities,
    profileName: identity.profileName,
    receivedAt: ctx.now,
    parts,
    replyToExternalId: body.replyToExternalId,
    ...(identity.verified ? { identityVerified: true } : {}),
    ...(identity.context ? { hostContext: identity.context } : {}),
  };
  return { messages: [message], statuses: [], ignored: 0 };
}
