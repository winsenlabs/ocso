import type { InteractionPart } from '@ocso/domain';
import type { InboundEnvelope, InboundMessage } from '../../contract/types.js';
import { clip, nonEmpty } from '../../common/text.js';
import { SLACK_IDENTITY, SLACK_TEXT_LIMIT } from '../capabilities.js';
import type { SlackSettings } from '../config.js';
import { slackIdentityValue } from '../identity.js';
import { slackReplyContext } from '../reply-context.js';
import { SLACK_CHOICE_ACTION_PREFIX, SLACK_CHOICE_REPLY_SCHEMA, SLACK_CHOICES_BLOCK_ID } from '../render.js';
import { slackJsonBody } from './body.js';
import { SlackBlockActionsPayload, SlackEventCallback, SlackMessageEvent, type SlackMessageEvent as MessageEvent } from './schema.js';
import { slackPlainText } from './text.js';

/**
 * A verified Slack request -> InboundEnvelope. Handled: `message` events in a
 * DM with the app (`message.im`) and `app_mention` in channels, as the
 * channel's `respondTo` / `allowedChannelIds` allow; `block_actions` taps on
 * OCSO's choice buttons (a STRUCTURED reply whose `data.id` is the option id),
 * under the same `respondTo` / `allowedChannelIds` gate and only from the user
 * the buttons were addressed to (`block_id` `ocso.choices:<user id>`, stamped
 * at send; an unaddressed block only in a DM, where no one else can press it).
 * Everything else — bot messages (including OCSO's own), edits, deletions,
 * joins and other subtypes, other events and payloads — is counted as ignored.
 */

export interface SlackParseOptions {
  settings: SlackSettings;
  now: () => Date;
}

/** Message subtypes that are still a person writing to the app. */
const USER_SUBTYPES: ReadonlySet<string> = new Set(['file_share', 'thread_broadcast']);

const empty = (ignored = 1): InboundEnvelope => ({ messages: [], statuses: [], ignored });

function tsDate(ts: string | undefined, fallback: Date): Date {
  const seconds = ts ? Number(ts) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? new Date(Math.round(seconds * 1000)) : fallback;
}

function profileName(event: MessageEvent): string | undefined {
  const profile = event.user_profile;
  const name = nonEmpty(profile?.display_name) ?? nonEmpty(profile?.real_name) ?? nonEmpty(profile?.name);
  return name ? clip(name, 200) : undefined;
}

/** Whether this event is one the channel answers (and in which conversation shape). */
function accepted(event: MessageEvent, settings: SlackSettings, botUserId: string | undefined): 'dm' | 'mention' | null {
  if (event.bot_id || event.bot_profile || event.hidden || event.edited !== undefined) return null;
  if (!event.user || (botUserId && event.user === botUserId) || !event.channel || !event.ts) return null;
  if (event.type === 'message') {
    if (event.subtype && !USER_SUBTYPES.has(event.subtype)) return null;
    if (event.channel_type !== 'im' || settings.respondTo === 'mentions') return null;
    return 'dm';
  }
  if (event.type === 'app_mention') {
    if (event.subtype && !USER_SUBTYPES.has(event.subtype)) return null;
    if (settings.respondTo === 'dm') return null;
    if (settings.allowedChannelIds.length && !settings.allowedChannelIds.includes(event.channel)) return null;
    return 'mention';
  }
  return null;
}

function eventMessage(callback: SlackEventCallback, options: SlackParseOptions): InboundMessage | null {
  const event = SlackMessageEvent.safeParse(callback.event);
  if (!event.success) return null;
  const botUserId = callback.authorizations?.find((a) => a.is_bot !== false)?.user_id ?? undefined;
  const shape = accepted(event.data, options.settings, botUserId);
  if (!shape) return null;
  const { user, channel, ts, thread_ts: threadTs } = event.data;
  const teamId = event.data.user_team ?? event.data.team ?? callback.team_id;
  const identity = teamId && user ? slackIdentityValue(teamId, user) : null;
  const text = clip(slackPlainText(event.data.text ?? '', botUserId), SLACK_TEXT_LIMIT);
  if (!identity || !text || !channel || !ts) return null;
  // DMs answer in the DM (in its thread when the customer wrote in one); mentions in their thread, or the channel.
  const replyThread = threadTs ?? (shape === 'mention' && options.settings.replyInThread ? ts : undefined);
  return {
    externalMessageId: callback.event_id,
    identityKind: SLACK_IDENTITY,
    identityValue: identity,
    alternateIdentities: [],
    profileName: profileName(event.data),
    receivedAt: tsDate(ts, options.now()),
    parts: [{ type: 'TEXT', text }],
    replyContext: slackReplyContext({ teamId: callback.team_id ?? teamId!, channel, threadTs: replyThread }),
  };
}

/** Whether the settings let a click in this conversation through: DMs (D…) as `respondTo` allows, channels as mentions are. */
function clickAllowed(channel: string, settings: SlackSettings): boolean {
  if (channel.startsWith('D')) return settings.respondTo !== 'mentions';
  if (settings.respondTo === 'dm') return false;
  return !settings.allowedChannelIds.length || settings.allowedChannelIds.includes(channel);
}

/** The buttons were addressed to this user (or are an unaddressed block in a DM, which only its member can press). */
function clickedByAddressee(blockId: string | undefined, userId: string, channel: string): boolean {
  if (blockId === `${SLACK_CHOICES_BLOCK_ID}:${userId}`) return true;
  return blockId === SLACK_CHOICES_BLOCK_ID && channel.startsWith('D');
}

function choiceMessage(payload: SlackBlockActionsPayload, options: SlackParseOptions): InboundMessage | null {
  const action = payload.actions.find((a) => a.type === 'button' && a.action_id.startsWith(SLACK_CHOICE_ACTION_PREFIX));
  if (!action) return null;
  const clickedIn = payload.container?.channel_id ?? payload.channel?.id;
  if (!clickedIn || !clickAllowed(clickedIn, options.settings) || !clickedByAddressee(action.block_id, payload.user.id, clickedIn)) return null;
  const id = nonEmpty(action.value) ?? action.action_id.slice(SLACK_CHOICE_ACTION_PREFIX.length);
  const title = nonEmpty(action.text?.text) ?? id;
  const teamId = payload.user.team_id ?? payload.team?.id;
  const identity = teamId ? slackIdentityValue(teamId, payload.user.id) : null;
  const channel = payload.container?.channel_id ?? payload.channel?.id;
  const messageTs = payload.container?.message_ts ?? payload.message?.ts;
  if (!identity || !channel || !id || !messageTs) return null;
  const part: InteractionPart = { type: 'STRUCTURED', schema: SLACK_CHOICE_REPLY_SCHEMA, data: { id, title, source: 'slack' }, fallbackText: clip(title, 4_000) };
  const threadTs = payload.message?.thread_ts ?? payload.container?.thread_ts;
  const actionTs = action.action_ts ?? '0';
  return {
    // One tap = one message; a second tap on the same question is a new answer.
    externalMessageId: `action:${channel}:${messageTs}:${payload.user.id}:${actionTs}`,
    identityKind: SLACK_IDENTITY,
    identityValue: identity,
    alternateIdentities: [],
    profileName: nonEmpty(payload.user.name) ?? nonEmpty(payload.user.username),
    receivedAt: tsDate(action.action_ts, options.now()),
    parts: [part],
    replyToExternalId: `${channel}:${messageTs}`,
    replyContext: slackReplyContext({ teamId: payload.team?.id ?? teamId!, channel, threadTs }),
  };
}

export function parseSlackRequest(rawBody: Buffer | null, options: SlackParseOptions): InboundEnvelope {
  const body = slackJsonBody(rawBody);
  const callback = SlackEventCallback.safeParse(body);
  if (callback.success) {
    const message = eventMessage(callback.data, options);
    return message ? { messages: [message], statuses: [], ignored: 0 } : empty();
  }
  const actions = SlackBlockActionsPayload.safeParse(body);
  if (actions.success) {
    const message = choiceMessage(actions.data, options);
    return message ? { messages: [message], statuses: [], ignored: 0 } : empty();
  }
  return empty();
}
