import type { WaContact, WaMessage } from './inbound/schema.js';

/**
 * WhatsApp identity namespaces. Since 2026 Meta sends a business-scoped user
 * id (BSUID, e.g. `US.13491208655302741918`) alongside — or, for username
 * users, instead of — the phone number. The BSUID is preferred as the primary
 * identity; the phone (E.164 with `+`) is kept as an alternate, and vice versa.
 */
export const WHATSAPP_IDENTITY = {
  PHONE: 'whatsapp_phone',
  BSUID: 'whatsapp_bsuid',
  PARENT_BSUID: 'whatsapp_parent_bsuid',
} as const;

const BSUID = /^[A-Z]{2}\.(?:ENT\.)?[A-Za-z0-9]{1,128}$/;
const PHONE_DIGITS = /^\d{6,15}$/;

export function normalizeBsuid(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && BSUID.test(trimmed) ? trimmed : undefined;
}

/** Meta phone ids are digits without `+`; OCSO stores E.164 (`+16505551234`). */
export function normalizePhone(value: string | undefined): string | undefined {
  const digits = value?.replace(/[\s()+-]/g, '');
  return digits && PHONE_DIGITS.test(digits) ? `+${digits}` : undefined;
}

export interface SenderIdentity {
  identityKind: string;
  identityValue: string;
  alternateIdentities: Array<{ kind: string; value: string }>;
  profileName?: string | undefined;
}

/** The contact entry describing this sender; falls back to the only contact when unambiguous. */
function contactFor(message: WaMessage, contacts: readonly WaContact[]): WaContact | undefined {
  const match = contacts.find(
    (c) => (message.from_user_id && c.user_id === message.from_user_id) || (message.from && c.wa_id === message.from),
  );
  return match ?? (contacts.length === 1 ? contacts[0] : undefined);
}

export function resolveSenderIdentity(message: WaMessage, contacts: readonly WaContact[]): SenderIdentity | null {
  const contact = contactFor(message, contacts);
  const bsuid = normalizeBsuid(message.from_user_id ?? contact?.user_id);
  const parent = normalizeBsuid(message.from_parent_user_id ?? contact?.parent_user_id);
  const phone = normalizePhone(message.from ?? contact?.wa_id);
  const candidates = [
    bsuid && { kind: WHATSAPP_IDENTITY.BSUID, value: bsuid },
    phone && { kind: WHATSAPP_IDENTITY.PHONE, value: phone },
    parent && { kind: WHATSAPP_IDENTITY.PARENT_BSUID, value: parent },
  ].filter((c): c is { kind: string; value: string } => Boolean(c));
  const [primary, ...alternates] = candidates;
  if (!primary) return null;
  const profileName = contact?.profile?.name?.trim() || contact?.profile?.username?.trim() || undefined;
  return {
    identityKind: primary.kind,
    identityValue: primary.value,
    alternateIdentities: alternates,
    profileName: profileName?.slice(0, 200),
  };
}

/** Outbound addressing: BSUIDs go in `recipient`, phones in `to` (digits only). */
export function recipientFields(identityKind: string, identityValue: string): Record<string, string> | null {
  if (identityKind === WHATSAPP_IDENTITY.BSUID || identityKind === WHATSAPP_IDENTITY.PARENT_BSUID) {
    const bsuid = normalizeBsuid(identityValue);
    return bsuid ? { recipient: bsuid } : null;
  }
  if (identityKind === WHATSAPP_IDENTITY.PHONE) {
    const phone = normalizePhone(identityValue);
    return phone ? { to: phone.slice(1) } : null;
  }
  return null;
}
