import type { OutboundTarget, RenderedOutbound, SendResult } from '../contract/types.js';
import { teamsSecretValues, type ResolvedTeamsConfig } from './config.js';
import type { BotConnectorClient } from './connector.js';
import { mapConnectorFailure, sendFailure } from './errors.js';
import { TEAMS_IDENTITY } from './identity.js';
import { teamsMessageId } from './inbound.js';
import { TeamsOutboundPayload } from './payload.js';
import { ADAPTIVE_CARD, CHOICE_MARKER, TEAMS_KIND } from './render.js';
import { fromReplyContext, type TeamsReplyContext } from './reply-context.js';

/**
 * Send one rendered payload through the Bot Connector. Where it goes: the
 * conversation reference of the customer message this answers
 * (`OutboundTarget.replyContext`, recorded by the inbound parser) — the
 * personal chat, group chat or channel thread — as a new message in it.
 * Without one, the send is meant for the person alone: it goes to the
 * personal chat they last wrote to the bot from (`personalChat`), never to a
 * shared chat; when OCSO knows none (a bot may only start a Teams chat
 * through proactive installation, which v1 does not do) the send fails
 * without retrying. Choice cards are addressed: each `Action.Submit`
 * carries the Entra object id of the customer asked, and the inbound parser
 * takes a tap only from that person (everyone in a channel sees the card).
 * The Bot Connector has no idempotency key, so a timeout after acceptance
 * plus a retry can duplicate a message.
 */

export interface TeamsSendContext {
  config: ResolvedTeamsConfig;
  connector: BotConnectorClient;
  /** The personal chat of this person on this channel, when a send has no reply context. */
  personalChat: (identityValue: string) => TeamsReplyContext | null;
}

function parsePayload(message: RenderedOutbound): TeamsOutboundPayload | null {
  if (message.kind !== TEAMS_KIND) return null;
  const parsed = TeamsOutboundPayload.safeParse(message.payload);
  return parsed.success ? parsed.data : null;
}

/** `<tenant>:<object id>` of a `teams_user` target, or null. */
function targetUser(target: OutboundTarget): { tenantId: string; aadObjectId: string } | null {
  if (target.identityKind !== TEAMS_IDENTITY.USER) return null;
  const [tenantId, aadObjectId, extra] = target.identityValue.split(':');
  return tenantId && aadObjectId && extra === undefined ? { tenantId, aadObjectId } : null;
}

/** Stamp the addressee on every OCSO choice submit action (buttons, and the list card's Send). */
function addressCard(card: Record<string, unknown>, aadObjectId: string): Record<string, unknown> {
  const actions = Array.isArray(card['actions']) ? (card['actions'] as unknown[]) : [];
  return {
    ...card,
    actions: actions.map((action) => {
      if (!action || typeof action !== 'object') return action;
      const data = (action as Record<string, unknown>)['data'];
      if ((action as Record<string, unknown>)['type'] !== 'Action.Submit' || !data || typeof data !== 'object' || (data as Record<string, unknown>)['ocso'] !== CHOICE_MARKER) return action;
      return { ...action, data: { ...data, for: aadObjectId } };
    }),
  };
}

function activityFor(payload: TeamsOutboundPayload, context: TeamsReplyContext, aadObjectId: string): Record<string, unknown> {
  const activity: Record<string, unknown> = { type: 'message', conversation: { id: context.conversationId } };
  if (context.botId) activity['from'] = { id: context.botId };
  if (payload.type === 'text') return { ...activity, textFormat: 'markdown', text: payload.text };
  return { ...activity, summary: payload.summary, attachments: [{ contentType: ADAPTIVE_CARD, content: addressCard(payload.card, aadObjectId) }] };
}

export async function sendTeamsMessage(target: OutboundTarget, message: RenderedOutbound, ctx: TeamsSendContext): Promise<SendResult> {
  const payload = parsePayload(message);
  if (!payload) return sendFailure('invalid_payload', 'message is not a valid Microsoft Teams payload');
  const user = targetUser(target);
  if (!user) return sendFailure('invalid_recipient', `cannot address a Microsoft Teams recipient of kind ${target.identityKind}`);
  const context = target.replyContext ? fromReplyContext(target.replyContext) : ctx.personalChat(target.identityValue);
  if (!context) {
    return sendFailure(
      'recipient_undeliverable',
      target.replyContext ? 'no Teams conversation to reply in' : 'no personal chat with this person: OCSO writes privately only to someone who recently messaged the bot 1:1',
    );
  }
  if (context.tenantId && context.tenantId.toLowerCase() !== user.tenantId) return sendFailure('invalid_recipient', 'the conversation belongs to another Microsoft 365 tenant');
  const result = await ctx.connector.sendActivity(context.serviceUrl, context.conversationId, activityFor(payload, context, user.aadObjectId));
  if (result.kind !== 'ok') return mapConnectorFailure(result, teamsSecretValues(ctx.config));
  const id = typeof result.body['id'] === 'string' && result.body['id'] ? result.body['id'] : 'unidentified';
  return { ok: true, externalMessageId: teamsMessageId(context.conversationId, id) };
}
