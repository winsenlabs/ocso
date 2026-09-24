import { z } from 'zod';
import type { OutboundTarget, RenderedOutbound, SendResult } from '../contract/types.js';
import { SLACK_IDENTITY } from './capabilities.js';
import { slackSecretValues, type ResolvedSlackConfig } from './config.js';
import { mapSlackFailure, sendFailure } from './errors.js';
import { parseSlackIdentity } from './identity.js';
import { SlackOutboundPayload } from './payload.js';
import { readSlackReplyContext } from './reply-context.js';
import { SLACK_CHOICES_BLOCK_ID } from './render.js';
import type { SlackWebApi } from './web-api.js';

/**
 * Send one rendered payload with `chat.postMessage`. Where it goes: the
 * conversation (and thread) of the customer's latest inbound message on this
 * conversation (`OutboundTarget.replyContext`, recorded by the inbound parser);
 * without one (OCSO starts the conversation, or an older message) it goes to
 * the customer's DM with the app, which `chat.postMessage` opens from the user
 * id with the `chat:write` scope alone. Links and media are not unfurled.
 * Choice buttons are addressed: their actions block's `block_id` becomes
 * `ocso.choices:<user id>` of the customer asked, and the inbound parser takes
 * a click only from that user (anyone in a channel can see and press them).
 * Slack has no idempotency key, so a timeout after acceptance plus a retry can
 * duplicate a message.
 */

export interface SlackSendContext {
  config: ResolvedSlackConfig;
  api: SlackWebApi;
}

const PostMessageResponse = z.looseObject({ channel: z.string().min(1), ts: z.string().regex(/^\d{1,12}\.\d{1,9}$/) });

function parsePayload(message: RenderedOutbound): SlackOutboundPayload | null {
  if (message.kind !== 'SLACK') return null;
  const parsed = SlackOutboundPayload.safeParse(message.payload);
  return parsed.success ? parsed.data : null;
}

/** Where a reply goes: the recorded conversation and thread, or the customer's DM. */
export function slackDestination(target: OutboundTarget): { channel: string; threadTs?: string | undefined } | null {
  if (target.identityKind !== SLACK_IDENTITY) return null;
  const identity = parseSlackIdentity(target.identityValue);
  if (!identity) return null;
  const context = readSlackReplyContext(target.replyContext);
  if (context) return context.threadTs ? { channel: context.channel, threadTs: context.threadTs } : { channel: context.channel };
  return { channel: identity.userId };
}

/** Stamp the addressed customer's user id on OCSO's choice buttons (see the inbound parser's click check). */
function addressChoices(blocks: readonly Record<string, unknown>[], userId: string): Record<string, unknown>[] {
  return blocks.map((block) => (block['type'] === 'actions' && block['block_id'] === SLACK_CHOICES_BLOCK_ID ? { ...block, block_id: `${SLACK_CHOICES_BLOCK_ID}:${userId}` } : block));
}

export async function sendSlackMessage(target: OutboundTarget, message: RenderedOutbound, ctx: SlackSendContext): Promise<SendResult> {
  const payload = parsePayload(message);
  if (!payload) return sendFailure('invalid_payload', 'message is not a valid Slack payload');
  const destination = slackDestination(target);
  if (!destination) return sendFailure('invalid_recipient', `cannot address a Slack recipient of kind ${target.identityKind}`);
  const body: Record<string, unknown> = {
    channel: destination.channel,
    text: payload.text,
    mrkdwn: true,
    unfurl_links: false,
    unfurl_media: false,
  };
  if (payload.type === 'blocks') body['blocks'] = addressChoices(payload.blocks, parseSlackIdentity(target.identityValue)!.userId);
  if (destination.threadTs) body['thread_ts'] = destination.threadTs;
  const result = await ctx.api.call('chat.postMessage', body);
  if (result.kind !== 'ok') return mapSlackFailure(result, slackSecretValues(ctx.config));
  const posted = PostMessageResponse.safeParse(result.body);
  // Accepted but unidentifiable: do not retry (it would duplicate the message).
  return posted.success
    ? { ok: true, externalMessageId: `${posted.data.channel}:${posted.data.ts}` }
    : sendFailure('provider_error', 'Slack accepted the message without a channel and ts');
}
