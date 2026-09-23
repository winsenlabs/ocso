import { z } from 'zod';
import type { ChannelCapabilities, OutboundMediaResolver, OutboundTarget, RenderedOutbound, SendResult } from '../contract/types.js';
import { withinSessionWindow } from '../contract/render-policy.js';
import { twilioSecretValues, type ResolvedTwilioConfig } from './config.js';
import { mapTwilioFailure, sendFailure, type SendFailure } from './errors.js';
import { phoneFromWhatsAppAddress, recipientAddress } from './identity.js';
import { TwilioOutboundPayload, type TwilioMediaPayload } from './payload.js';
import type { TwilioRestClient } from './rest-client.js';

/**
 * Send one rendered payload as `POST /2010-04-01/Accounts/{sid}/Messages.json`
 * (form-encoded). Checks, in order: payload shape, recipient, 24-hour window
 * (Content Templates exempt), media URL; then the call. When the channel asks
 * for statuses and has an https webhook URL, it is passed as StatusCallback
 * (overrides the sender / Messaging Service setting). Twilio has no
 * idempotency key, so a timeout after acceptance plus a retry can duplicate.
 */

export interface TwilioSendContext {
  config: ResolvedTwilioConfig;
  client: TwilioRestClient;
  capabilities: ChannelCapabilities;
  media: OutboundMediaResolver;
  now: Date;
}

const MessageResponse = z.object({ sid: z.string().regex(/^(SM|MM)[0-9a-fA-F]{32}$/) });

function parsePayload(message: RenderedOutbound): TwilioOutboundPayload | null {
  if (message.kind !== 'TWILIO_WHATSAPP') return null;
  const parsed = TwilioOutboundPayload.safeParse(message.payload);
  return parsed.success ? parsed.data : null;
}

/** From = the number the customer wrote to (when known) or the configured sender; else the Messaging Service. */
function setSender(form: URLSearchParams, target: OutboundTarget, config: ResolvedTwilioConfig): void {
  const { from, messagingServiceSid } = config.settings;
  if (from) {
    const account = target.channelAccountId && phoneFromWhatsAppAddress(target.channelAccountId) ? target.channelAccountId : from;
    form.set('From', account);
  } else if (messagingServiceSid) {
    form.set('MessagingServiceSid', messagingServiceSid);
  }
}

async function mediaUrl(payload: TwilioMediaPayload, ctx: TwilioSendContext): Promise<string | SendFailure> {
  let url: string;
  try {
    url = await ctx.media.signedUrl(payload.blobKey, ctx.config.settings.mediaLinkTtlSeconds);
  } catch {
    return sendFailure('media_unavailable', 'could not create a signed URL for outbound media', true);
  }
  return URL.canParse(url) && /^https?:$/.test(new URL(url).protocol) ? url : sendFailure('media_unavailable', 'signed media URL is not an http(s) URL');
}

async function setContent(form: URLSearchParams, payload: TwilioOutboundPayload, ctx: TwilioSendContext): Promise<SendFailure | null> {
  switch (payload.type) {
    case 'text':
      form.set('Body', payload.body);
      return null;
    case 'media': {
      const url = await mediaUrl(payload, ctx);
      if (typeof url !== 'string') return url;
      form.set('MediaUrl', url);
      if (payload.caption) form.set('Body', payload.caption);
      return null;
    }
    case 'location':
      form.set('Body', payload.name);
      form.set('PersistentAction', `geo:${payload.latitude},${payload.longitude}${payload.label ? `|${payload.label}` : ''}`);
      return null;
    case 'template':
      form.set('ContentSid', payload.template.contentSid);
      if (payload.template.variables && Object.keys(payload.template.variables).length) {
        form.set('ContentVariables', JSON.stringify(payload.template.variables));
      }
      return null;
  }
}

export async function sendTwilioMessage(target: OutboundTarget, message: RenderedOutbound, ctx: TwilioSendContext): Promise<SendResult> {
  const payload = parsePayload(message);
  if (!payload) return sendFailure('invalid_payload', 'message is not a valid Twilio WhatsApp payload');
  const to = recipientAddress(target.identityKind, target.identityValue);
  if (!to) return sendFailure('invalid_recipient', `cannot address a Twilio WhatsApp recipient of kind ${target.identityKind}`);
  if (payload.type !== 'template' && !withinSessionWindow(ctx.capabilities, target.lastInboundAt, ctx.now)) {
    return {
      ok: false,
      errorCode: 'outside_session_window',
      message: 'the 24-hour customer service window is closed; send an approved Content Template (ContentSid) instead',
      retriable: false,
      requiresTemplate: true,
    };
  }
  const form = new URLSearchParams();
  form.set('To', to);
  setSender(form, target, ctx.config);
  const contentFailure = await setContent(form, payload, ctx);
  if (contentFailure) return contentFailure;
  if (ctx.config.settings.statusCallback && ctx.config.webhookUrl?.startsWith('https://')) form.set('StatusCallback', ctx.config.webhookUrl);
  const result = await ctx.client.postForm(ctx.client.accountUrl('Messages'), form);
  if (result.kind !== 'ok') return mapTwilioFailure(result, twilioSecretValues(ctx.config));
  const parsed = MessageResponse.safeParse(result.body);
  // Accepted but unidentifiable: do not retry (it would duplicate the message).
  return parsed.success ? { ok: true, externalMessageId: parsed.data.sid } : sendFailure('provider_error', 'Twilio accepted the message without a message SID');
}
