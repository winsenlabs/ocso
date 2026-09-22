import { InteractionPart } from '@ocso/domain';
import type { InboundMessage } from '../../contract/types.js';
import { nonEmpty } from '../../common/text.js';
import { normalizeBsuid, normalizePhone, WHATSAPP_IDENTITY } from '../../whatsapp/identity.js';
import type { FormRecord } from '../form.js';
import { phoneFromWhatsAppAddress, TWILIO_WHATSAPP_PREFIX } from '../identity.js';
import { locationPart, mediaParts, textPart } from './content-parts.js';
import { buttonPart, flowPart, referralPart } from './structured-parts.js';

/**
 * One inbound WhatsApp message webhook -> InboundMessage. The idempotency key
 * is the MessageSid (Twilio may deliver the same webhook again). Identity is
 * the sender's phone as `whatsapp_phone` (E.164) — the Meta adapter's kind, so
 * one person is one customer across both integrations — with the 2026 BSUID
 * (`ExternalUserId`, `whatsapp:CC.…`) kept as a `whatsapp_bsuid` alternate.
 */

const MESSAGE_SID = /^[A-Z]{2}[0-9a-fA-F]{32}$/;

function stripPrefix(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed?.toLowerCase().startsWith(TWILIO_WHATSAPP_PREFIX) ? trimmed.slice(TWILIO_WHATSAPP_PREFIX.length) : trimmed;
}

function senderIdentity(form: FormRecord): Pick<InboundMessage, 'identityKind' | 'identityValue' | 'alternateIdentities' | 'profileName'> | null {
  const phone = phoneFromWhatsAppAddress(form['From']) ?? normalizePhone(form['WaId']);
  // When a user hides their number, Twilio puts the BSUID in From/To as well.
  const bsuid = normalizeBsuid(stripPrefix(form['ExternalUserId'])) ?? normalizeBsuid(stripPrefix(form['From']));
  const candidates: Array<{ kind: string; value: string }> = [];
  if (phone) candidates.push({ kind: WHATSAPP_IDENTITY.PHONE, value: phone });
  if (bsuid) candidates.push({ kind: WHATSAPP_IDENTITY.BSUID, value: bsuid });
  const [primary, ...alternates] = candidates;
  if (!primary) return null;
  const profileName = nonEmpty(form['ProfileName'])?.slice(0, 200);
  return { identityKind: primary.kind, identityValue: primary.value, alternateIdentities: alternates, ...(profileName ? { profileName } : {}) };
}

/** Keep only parts that satisfy the canonical domain schema (defaults applied). */
function canonicalParts(parts: ReadonlyArray<InteractionPart | null>): InteractionPart[] {
  return parts.flatMap((part) => {
    const parsed = part ? InteractionPart.safeParse(part) : null;
    return parsed?.success ? [parsed.data] : [];
  });
}

function contentParts(form: FormRecord): InteractionPart[] {
  const body = nonEmpty(form['Body']);
  const media = mediaParts(form, body);
  const button = buttonPart(form);
  // A button tap repeats its title in Body; a media caption is already on the part.
  const bodyIsEcho = media.captionUsed || (button !== null && body === nonEmpty(form['ButtonText']));
  return canonicalParts([
    button,
    flowPart(form),
    ...media.parts,
    locationPart(form),
    bodyIsEcho ? null : textPart(body),
    referralPart(form),
  ]);
}

/** Null when the webhook is not a usable WhatsApp message (counted as ignored). */
export function normalizeTwilioMessage(form: FormRecord, now: () => Date): InboundMessage | null {
  const sid = nonEmpty(form['MessageSid']) ?? nonEmpty(form['SmsMessageSid']);
  if (!sid || !MESSAGE_SID.test(sid)) return null;
  if (!form['From']?.trim().toLowerCase().startsWith(TWILIO_WHATSAPP_PREFIX)) return null;
  const identity = senderIdentity(form);
  if (!identity) return null;
  const parts = contentParts(form);
  if (!parts.length) return null;
  const to = nonEmpty(form['To']);
  return {
    externalMessageId: sid,
    ...identity,
    channelAccountId: to?.toLowerCase().startsWith(TWILIO_WHATSAPP_PREFIX) ? to : undefined,
    receivedAt: now(),
    parts,
    replyToExternalId: nonEmpty(form['OriginalRepliedMessageSid']),
  };
}
