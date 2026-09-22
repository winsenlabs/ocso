import { normalizeBsuid, normalizePhone, WHATSAPP_IDENTITY } from '../whatsapp/identity.js';

/**
 * Twilio addresses WhatsApp users as `whatsapp:+<E.164>`. OCSO stores the
 * phone as a `whatsapp_phone` identity (`+14155551234`) — the same kind the
 * Meta Cloud API adapter uses — so a customer is one customer whichever
 * WhatsApp integration they reached.
 */

export const TWILIO_WHATSAPP_PREFIX = 'whatsapp:';

/** `whatsapp:+14155551234` -> `+14155551234`; undefined for SMS or malformed addresses. */
export function phoneFromWhatsAppAddress(address: string | undefined): string | undefined {
  const value = address?.trim();
  if (!value?.toLowerCase().startsWith(TWILIO_WHATSAPP_PREFIX)) return undefined;
  const rest = value.slice(TWILIO_WHATSAPP_PREFIX.length);
  return rest.startsWith('+') ? normalizePhone(rest) : undefined;
}

/** `+14155551234` or `whatsapp:+14155551234` -> `whatsapp:+14155551234`. */
export function toWhatsAppAddress(value: string): string {
  const trimmed = value.trim();
  return trimmed.toLowerCase().startsWith(TWILIO_WHATSAPP_PREFIX) ? `${TWILIO_WHATSAPP_PREFIX}${trimmed.slice(TWILIO_WHATSAPP_PREFIX.length)}` : `${TWILIO_WHATSAPP_PREFIX}${trimmed}`;
}

/**
 * Outbound `To` for an identity. Phones are the normal case; a BSUID is used
 * only for customers who hide their number, in the `whatsapp:CC.…` form
 * Twilio puts in From for them (sending to it is UNVERIFIED, research/06 §1).
 */
export function recipientAddress(identityKind: string, identityValue: string): string | null {
  if (identityKind === WHATSAPP_IDENTITY.PHONE) {
    const phone = normalizePhone(identityValue);
    return phone ? `${TWILIO_WHATSAPP_PREFIX}${phone}` : null;
  }
  if (identityKind === WHATSAPP_IDENTITY.BSUID) {
    const bsuid = normalizeBsuid(identityValue);
    return bsuid ? `${TWILIO_WHATSAPP_PREFIX}${bsuid}` : null;
  }
  return null;
}
