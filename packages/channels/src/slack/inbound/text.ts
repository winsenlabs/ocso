/**
 * Slack message text -> plain text for the agent. Slack sends mrkdwn with
 * control sequences in angle brackets and `&`, `<`, `>` escaped
 * (api.slack.com/reference/surfaces/formatting): mentions of the app are
 * removed, other users, channels, links and broadcasts become readable text.
 */

const CONTROL = /<([^<>\n]{1,2000})>/g;

function unescape(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function control(inner: string, botUserId: string | undefined): string {
  const [target = '', label] = inner.split('|', 2) as [string, string | undefined];
  if (target.startsWith('@')) {
    const id = target.slice(1);
    if (botUserId && id === botUserId) return '';
    return label ? `@${label}` : `@${id}`;
  }
  if (target.startsWith('#')) return label ? `#${label}` : `#${target.slice(1)}`;
  if (target.startsWith('!subteam^')) return label ?? '@group';
  if (target.startsWith('!')) {
    const name = target.slice(1).split('^')[0] ?? '';
    return ['here', 'channel', 'everyone'].includes(name) ? `@${name}` : (label ?? '');
  }
  if (target.startsWith('mailto:')) return label ?? target.slice('mailto:'.length);
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return label && label !== target ? `${label} (${target})` : target;
  return `<${inner}>`;
}

/** Plain text of a Slack message, with the app's own mention (`<@Ubot>`) stripped. */
export function slackPlainText(text: string, botUserId?: string | undefined): string {
  return unescape(text.replace(CONTROL, (_m, inner: string) => control(inner, botUserId)))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .trim();
}
