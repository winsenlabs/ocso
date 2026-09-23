/**
 * The shapes OCSO's registries accept, one copy for plugin authors. The
 * registries inside OCSO check the same patterns at start-up; a repo test
 * keeps these in agreement with them.
 */

/** Channel kinds: upper snake case, 2–40 characters (`LINE`, `ACME_SMS`). */
export const CHANNEL_KIND_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;

/** Model provider kinds: upper snake case, 2–40 characters. */
export const PROVIDER_KIND_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;

/** Alert destination kinds: upper snake case, 2–40 characters. */
export const DESTINATION_KIND_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;

/** Driver names (EMAIL_DRIVER=…): lower case a-z0-9-, 1–40 characters. */
export const DRIVER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

/** Channel mark badge text: 1–3 letters or digits. */
export const MARK_CODE_PATTERN = /^[A-Za-z0-9]{1,3}$/;

/** Inbound webhook URL segment: lower case a-z0-9-, 1–40 characters. */
export const WEBHOOK_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** `TWILIO_WHATSAPP` → `twilio-whatsapp`: the default webhook URL segment of a channel kind. */
export function defaultWebhookSegment(kind: string): string {
  return kind.toLowerCase().replace(/_/g, '-');
}

/** Path prefix of OCSO's widget page for embeddable channel kinds (`/chat/<publicKey>`). */
export const EMBED_PAGE_PREFIX = '/chat';
