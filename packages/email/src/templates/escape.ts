/** Escaping and value formatting shared by every template. */

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** One line of text for a subject / heading: control characters and line breaks collapse to a space. */
export function oneLine(text: string, max = 200): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Links in emails must be absolute http(s). Anything else (javascript:, data:,
 * relative paths, credentials in the URL) is a programming error — throw
 * rather than render a dangerous or broken link.
 */
export function safeUrl(value: string, label = 'link'): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`email ${label} must be an absolute URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`email ${label} must use http or https`);
  if (url.username || url.password) throw new Error(`email ${label} must not contain credentials`);
  return url.href;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "22 Sep 2026, 10:00 UTC" in the organization's time zone (UTC by default); month names fixed, not ICU's. */
export function formatDateTime(at: Date, timeZone = 'UTC'): string {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
  } catch {
    return formatDateTime(at, 'UTC');
  }
  const parts = Object.fromEntries(formatter.formatToParts(at).map((p) => [p.type, p.value]));
  const month = MONTHS[Number(parts['month']) - 1] ?? parts['month'];
  return `${parts['day']} ${month} ${parts['year']}, ${parts['hour']}:${parts['minute']} ${parts['timeZoneName']}`;
}

/** "in 15 minutes", "in 2 hours", "in 7 days" — rounded to the unit a reader cares about. */
export function formatRelative(at: Date, now: Date): string {
  const minutes = Math.max(1, Math.round((at.getTime() - now.getTime()) / 60_000));
  if (minutes < 90) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} hours`;
  const days = Math.round(hours / 24);
  return `in ${days} days`;
}

/** Expiry sentence fragment: "in 7 days (29 Sep 2026, 10:00 UTC)". */
export function formatExpiry(expiresAt: Date, now: Date, timeZone?: string): string {
  return `${formatRelative(expiresAt, now)} (${formatDateTime(expiresAt, timeZone)})`;
}

/**
 * Coarse network location for security notices: IPv4 → /24 (`203.0.113.x`),
 * IPv6 → /48 (`2001:db8:85a3::/48`). Precise enough to recognise a network,
 * without mailing out a full address.
 */
export function coarseIp(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i.exec(ip.trim());
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.x`;
  if (ip.includes(':')) {
    const head = ip.trim().split('::')[0]!.split(':').filter(Boolean).slice(0, 3);
    while (head.length < 3) head.push('0');
    return `${head.join(':')}::/48`;
  }
  return 'unknown network';
}
