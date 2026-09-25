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

/** Setup-file placeholders: `{{webhookUrl}}`, `{{webhookHost}}` and `{{settings.<key>}}` only (secrets are never interpolated). */
export const SETUP_FILE_PLACEHOLDER_PATTERN = /^\{\{\s*(webhookUrl|webhookHost|settings\.[A-Za-z][A-Za-z0-9_]{0,63})\s*\}\}$/;

/** Troubleshooting entry ids: lower case a-z0-9-, 1–40 characters. */
export const TROUBLESHOOTING_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

/** Setup-file keys: lower case a-z0-9-, 1–40 characters. */
export const SETUP_FILE_KEY_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

/** Setup-file download names: letters, digits, `.`, `_`, `-`, at most 100 characters. */
export const SETUP_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Limits of an inbound `replyContext`: at most this many keys and this many bytes of JSON; OCSO drops a larger one. */
export const REPLY_CONTEXT_MAX_KEYS = 16;
export const REPLY_CONTEXT_MAX_BYTES = 4096;
