import { z } from 'zod';
import type { ChannelCapabilities, OutboundMediaResolver, OutboundTarget, RenderedOutbound, SendResult } from '../contract/types.js';
import { withinSessionWindow } from '../contract/render-policy.js';
import { secretValues, type ResolvedWhatsAppConfig } from './config.js';
import { mapGraphFailure, sendFailure } from './errors.js';
import { isSafePathSegment, type GraphClient } from './graph-client.js';
import { recipientFields } from './identity.js';
import { buildMessageBody } from './message-body.js';
import { resolveOutboundMedia, type MediaObjectSource } from './outbound-media.js';
import { WhatsAppOutboundPayload } from './payload.js';

/**
 * Send one rendered payload. Order of checks: payload shape, recipient,
 * 24-hour session window (templates exempt), media resolution, then the
 * Graph call. Delivery is at-least-once: Meta has no idempotency key, so a
 * timeout after acceptance followed by a retry can duplicate (ADR-007).
 */

export interface SendContext {
  config: ResolvedWhatsAppConfig;
  graph: GraphClient;
  capabilities: ChannelCapabilities;
  media: OutboundMediaResolver;
  now: Date;
}

const SendResponse = z.object({ messages: z.array(z.object({ id: z.string().min(1) })).min(1) });

function parsePayload(message: RenderedOutbound): WhatsAppOutboundPayload | null {
  if (message.kind !== 'WHATSAPP') return null;
  const parsed = WhatsAppOutboundPayload.safeParse(message.payload);
  return parsed.success ? parsed.data : null;
}

export async function sendWhatsAppMessage(
  target: OutboundTarget,
  message: RenderedOutbound,
  ctx: SendContext,
): Promise<SendResult> {
  const payload = parsePayload(message);
  if (!payload) return sendFailure('invalid_payload', 'message is not a valid WhatsApp payload');
  const recipient = recipientFields(target.identityKind, target.identityValue);
  if (!recipient) return sendFailure('invalid_recipient', `cannot address WhatsApp recipient of kind ${target.identityKind}`);
  const phoneNumberId = target.channelAccountId ?? ctx.config.settings.phoneNumberId;
  if (!isSafePathSegment(phoneNumberId)) return sendFailure('invalid_channel_account', 'invalid WhatsApp phone number id');
  if (payload.type !== 'template' && !withinSessionWindow(ctx.capabilities, target.lastInboundAt, ctx.now)) {
    return {
      ok: false,
      errorCode: 'outside_session_window',
      message: 'the 24-hour customer service window is closed; send an approved template instead',
      retriable: false,
      requiresTemplate: true,
    };
  }
  const secrets = secretValues(ctx.config);
  let media: MediaObjectSource | null = null;
  if (payload.type === 'media') {
    const resolved = await resolveOutboundMedia(payload, {
      mode: ctx.config.settings.outboundMediaMode,
      linkTtlSeconds: ctx.config.settings.mediaLinkTtlSeconds,
      phoneNumberId,
      graph: ctx.graph,
      capabilities: ctx.capabilities,
      resolver: ctx.media,
      secrets,
    });
    if ('ok' in resolved) return resolved;
    media = resolved;
  }
  const result = await ctx.graph.postJson([phoneNumberId, 'messages'], buildMessageBody(payload, recipient, media));
  if (result.kind !== 'ok') return mapGraphFailure(result, secrets);
  const parsed = SendResponse.safeParse(result.body);
  const id = parsed.success ? parsed.data.messages[0]?.id : undefined;
  // Accepted but unidentifiable: do not retry (it would duplicate the message).
  return id ? { ok: true, externalMessageId: id } : sendFailure('provider_error', 'WhatsApp accepted the message without an id');
}
