import { InteractionPart } from '@ocso/domain';
import type { InboundMessage } from '../../contract/types.js';
import { resolveSenderIdentity } from '../identity.js';
import { normalizeContacts, normalizeLocation, normalizeText } from './content-parts.js';
import {
  normalizeAudio,
  normalizeDocument,
  normalizeImage,
  normalizeSticker,
  normalizeVideo,
  normalizeVoice,
} from './media-parts.js';
import { unixSecondsToDate, WaMessageBase, type WaContact, type WaMessage } from './schema.js';
import { normalizeInteractive, normalizeLegacyButton, normalizeReaction, referralPart } from './structured-parts.js';

/**
 * Per-type normalizer registry. Types absent here (`order`, `unsupported`,
 * `system`, `request_welcome`, anything new) are counted as ignored by the
 * caller rather than guessed at.
 */
type MessageNormalizer = (message: WaMessage) => InteractionPart[] | null;

export const MESSAGE_NORMALIZERS: ReadonlyMap<string, MessageNormalizer> = new Map<string, MessageNormalizer>([
  ['text', normalizeText],
  ['image', normalizeImage],
  ['sticker', normalizeSticker],
  ['audio', normalizeAudio],
  ['voice', normalizeVoice],
  ['video', normalizeVideo],
  ['document', normalizeDocument],
  ['location', normalizeLocation],
  ['contacts', normalizeContacts],
  ['interactive', normalizeInteractive],
  ['button', normalizeLegacyButton],
  ['reaction', normalizeReaction],
]);

export interface MessageContext {
  contacts: readonly WaContact[];
  channelAccountId: string;
  now: () => Date;
}

/** Keep only parts that satisfy the canonical domain schema (defaults applied). */
function canonicalParts(parts: readonly InteractionPart[]): InteractionPart[] {
  return parts.flatMap((part) => {
    const parsed = InteractionPart.safeParse(part);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Normalize one `messages[]` element; null means "ignored". */
export function normalizeMessage(raw: unknown, ctx: MessageContext): InboundMessage | null {
  const base = WaMessageBase.safeParse(raw);
  if (!base.success) return null;
  const message = base.data;
  const normalize = MESSAGE_NORMALIZERS.get(message.type);
  if (!normalize) return null;
  const identity = resolveSenderIdentity(message, ctx.contacts);
  const own = normalize(message);
  if (!identity || !own) return null;
  const referral = referralPart(message);
  const parts = canonicalParts(referral ? [...own, referral] : own);
  if (!parts.length) return null;
  return {
    externalMessageId: message.id,
    ...identity,
    channelAccountId: ctx.channelAccountId,
    receivedAt: unixSecondsToDate(message.timestamp, ctx.now),
    parts,
    replyToExternalId: message.context?.id,
  };
}
