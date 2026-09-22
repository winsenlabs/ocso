/**
 * Mailbox parsing for EMAIL_FROM / EMAIL_REPLY_TO: `addr@example.com` or
 * `Display Name <addr@example.com>`. Deliberately conservative — config is
 * validated once at start-up, so a strict check beats a surprising bounce.
 */
export interface Mailbox {
  name: string | null;
  address: string;
}

const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const WITH_NAME = /^(.*?)\s*<([^<>\s]+)>$/;
/** Display names made only of these need no quoting (RFC 5322 atext + space). */
const PLAIN_NAME = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ .]+$/;

export function isEmailAddress(value: string): boolean {
  return value.length <= 254 && ADDRESS.test(value) && !value.startsWith('.') && !value.includes('..');
}

/** Parse a mailbox; null when it is not a single valid address (with optional display name). */
export function parseMailbox(value: string): Mailbox | null {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n\0]/.test(trimmed)) return null;
  const named = WITH_NAME.exec(trimmed);
  if (!named) return isEmailAddress(trimmed) ? { name: null, address: trimmed } : null;
  const address = named[2]!;
  if (!isEmailAddress(address)) return null;
  let name = named[1]!.trim();
  if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) name = name.slice(1, -1).replace(/\\(.)/g, '$1');
  if (name.length > 100 || /[<>]/.test(name)) return null;
  return { name: name || null, address };
}

/** Render a mailbox for a From / Reply-To field, quoting the display name when needed. */
export function formatMailbox(mailbox: Mailbox): string {
  if (!mailbox.name) return mailbox.address;
  const name = PLAIN_NAME.test(mailbox.name) ? mailbox.name : `"${mailbox.name.replace(/(["\\])/g, '\\$1')}"`;
  return `${name} <${mailbox.address}>`;
}

/** Validate + normalize; throws with a message that names the setting, never other values. */
export function normalizeMailbox(value: string, setting: string): string {
  const parsed = parseMailbox(value);
  if (!parsed) throw new Error(`${setting} must be an email address, optionally with a display name ("OCSO <no-reply@example.com>")`);
  return formatMailbox(parsed);
}

/** The bare address of a mailbox string (`"A" <a@b.c>` → `a@b.c`), or the input when unparsable. */
export function mailboxAddress(value: string): string {
  return parseMailbox(value)?.address ?? value;
}

/**
 * Recipient summary safe for logs and errors: count plus the domain of the
 * first address (`2 recipients @meridian.example`), never the full list.
 */
export function describeRecipients(to: string | readonly string[]): string {
  const list = [to].flat();
  const domain = mailboxAddress(list[0] ?? '').split('@')[1];
  return `${list.length} recipient${list.length === 1 ? '' : 's'}${domain ? ` @${domain}` : ''}`;
}
