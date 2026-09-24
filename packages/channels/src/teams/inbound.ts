import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { InteractionPart } from '@ocso/domain';
import type { InboundEnvelope, InboundMessage } from '../contract/types.js';
import { invalidInbound } from '../common/errors.js';
import { clip } from '../common/text.js';
import { readJson, TeamsActivity } from './activity.js';
import type { TeamsSettings } from './config.js';
import { TEAMS_IDENTITY, teamsUserIdentity } from './identity.js';
import { CHOICE_INPUT_ID, CHOICE_MARKER } from './render.js';
import { toReplyContext } from './reply-context.js';

/**
 * Bot Framework activity → canonical inbound message. Handled: `message`
 * activities from Teams (personal chats, and channel or group chats where the
 * bot is @mentioned; the bot's own mention is removed), including Adaptive
 * Card `Action.Submit` taps on OCSO's choice cards, which become STRUCTURED
 * `button_reply` parts carrying the option id. Everything else
 * (`conversationUpdate`, `typing`, `messageReaction`, `invoke`, `installationUpdate`,
 * other channels such as the Azure portal's Web Chat test, other tenants of a
 * single-tenant bot, attachments without text) is counted in `ignored`.
 */

export const TEAMS_CHANNEL_ID = 'msteams';
export const TEAMS_CHOICE_REPLY_SCHEMA = 'button_reply';
const TEXT_LIMIT = 28_000;

const ChoiceValue = z.looseObject({
  ocso: z.literal(CHOICE_MARKER),
  id: z.string().min(1).max(200).optional(),
  label: z.string().min(1).max(200).optional(),
  labels: z.record(z.string().max(200), z.string().max(200)).optional(),
  /** The Entra object id of the person the card was sent to (stamped by `send`); taps by anyone else are ignored. */
  for: z.string().max(128).optional(),
  [CHOICE_INPUT_ID]: z.string().max(200).optional(),
});

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#\d{1,6}|#x[0-9a-f]{1,6}|[a-z]{2,6}|#39);/gi, (whole, name: string) => {
    const known = ENTITIES[name.toLowerCase()];
    if (known !== undefined) return known;
    const code = name.startsWith('#x') || name.startsWith('#X') ? Number.parseInt(name.slice(2), 16) : name.startsWith('#') ? Number(name.slice(1)) : NaN;
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The customer's words: the bot's own @mention removed, other mentions kept as `@Name`, light HTML removed. */
export function messageText(activity: TeamsActivity): string {
  let text = activity.text ?? '';
  const botId = activity.recipient?.id;
  for (const entity of activity.entities ?? []) {
    if (entity.type !== 'mention' || !entity.text || entity.mentioned?.id !== botId) continue;
    text = text.replace(new RegExp(escapeRegExp(entity.text), 'g'), ' ');
  }
  text = text
    .replace(/<at[^>]*>(.*?)<\/at>/gi, '@$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<\/?(?:p|div|span|strong|em|b|i|u|s|code|pre)[^>]*>/gi, '');
  return clip(decodeEntities(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), TEXT_LIMIT);
}

/**
 * An OCSO choice card tap → the STRUCTURED reply routers and agents understand (`data.id` = option id).
 * `undefined` when the value is not an OCSO choice; `null` when it is one this person may not answer
 * (a card addressed to someone else in a group chat or channel) or an option the card did not offer.
 */
export function choicePart(value: unknown, fromAadObjectId?: string | null): InteractionPart | null | undefined {
  const parsed = ChoiceValue.safeParse(value);
  if (!parsed.success) return undefined;
  const addressee = parsed.data.for;
  if (addressee !== undefined && addressee.toLowerCase() !== fromAadObjectId?.toLowerCase()) return null;
  const { id: tapped, label, labels } = parsed.data;
  const id = tapped ?? parsed.data[CHOICE_INPUT_ID];
  if (!id) return null;
  // A list card offers the option ids it rendered: anything else is not an answer to it.
  if (!tapped && labels && !Object.hasOwn(labels, id)) return null;
  const title = label ?? labels?.[id] ?? id;
  return { type: 'STRUCTURED', schema: TEAMS_CHOICE_REPLY_SCHEMA, data: { id, title, source: 'teams' }, fallbackText: clip(title, 4_000) };
}

/**
 * Idempotency key (and the id of OCSO's own sent activities): activity ids are only unique within a
 * conversation (personal chat ids are timestamps), so the conversation is part of it.
 */
export function teamsMessageId(conversationId: string, activityId: string): string {
  const scope = createHash('sha256').update(conversationId).digest('hex').slice(0, 24);
  return `teams:${scope}:${activityId.slice(0, 200)}`;
}

export interface TeamsParseOptions {
  settings: TeamsSettings;
  now: () => Date;
}

const nothing = (ignored = 1): InboundEnvelope => ({ messages: [], statuses: [], ignored });

export function parseTeamsActivity(rawBody: Buffer | null, options: TeamsParseOptions): InboundEnvelope {
  const json = readJson(rawBody);
  if (json === null) throw invalidInbound('teams_invalid_body', 'activity body is empty, too large or not JSON');
  const parsed = TeamsActivity.safeParse(json);
  if (!parsed.success) throw invalidInbound('teams_invalid_activity', 'body is not a Bot Framework activity');
  const activity = parsed.data;
  if (activity.type !== 'message' || activity.channelId !== TEAMS_CHANNEL_ID) return nothing();
  const { from, conversation, recipient, id } = activity;
  if (!from || !conversation || !recipient || !id || from.id === recipient.id) return nothing();
  const tenantId = conversation.tenantId ?? activity.channelData?.tenant?.id ?? null;
  if (!tenantId) return nothing();
  // A single-tenant bot answers its own tenant only (Azure enforces it too; this is defense in depth).
  if (options.settings.appType === 'SingleTenant' && tenantId.toLowerCase() !== options.settings.tenantId?.toLowerCase()) return nothing();
  const identityValue = teamsUserIdentity(tenantId, from.aadObjectId);
  if (!identityValue) return nothing();

  const choice = choicePart(activity.value, from.aadObjectId);
  if (choice === null) return nothing();
  const parts: InteractionPart[] = [];
  if (choice) parts.push(choice);
  else {
    const text = messageText(activity);
    if (text) parts.push({ type: 'TEXT', text });
  }
  if (!parts.length) return nothing();

  const message: InboundMessage = {
    externalMessageId: teamsMessageId(conversation.id, id),
    identityKind: TEAMS_IDENTITY.USER,
    identityValue,
    alternateIdentities: [],
    profileName: from.name ? clip(from.name.trim(), 200) || undefined : undefined,
    receivedAt: options.now(),
    parts,
    replyContext: toReplyContext(activity, tenantId),
  };
  return { messages: [message], statuses: [], ignored: 0 };
}
