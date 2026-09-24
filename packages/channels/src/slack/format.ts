/**
 * CommonMark-ish -> Slack mrkdwn (api.slack.com/reference/surfaces/formatting):
 * `**b**`/`__b__` -> `*b*`, `*i*`/`_i_` -> `_i_`, `~~s~~` -> `~s~`, links ->
 * `<url|label>` (http(s) and mailto targets only; any other target is plain text, so an agent cannot
 * emit `<!channel>`, `<@U…>` or `<!subteam^…>`), headings -> bold lines, bullets -> `•`, tables -> readable
 * rows, rules dropped; fenced and inline code kept. `&`, `<` and `>` are
 * escaped everywhere (Slack's control characters), except a leading `>` that
 * quotes a line. Code, links and URLs are shielded with private-use
 * placeholders so their `*`/`_` are never reinterpreted.
 */

const PLACEHOLDER = /\uE000(\d+)\uE001/g;
const BOLD = '\uE002';
const PRIVATE_USE = /[\uE000-\uE002]/g;

class Shield {
  private readonly saved: string[] = [];

  hide(value: string): string {
    this.saved.push(value);
    return `\uE000${this.saved.length - 1}\uE001`;
  }

  restore(text: string): string {
    let out = text;
    for (let pass = 0; pass < 3 && out.includes('\uE000'); pass += 1) {
      out = out.replace(PLACEHOLDER, (_, index: string) => this.saved[Number(index)] ?? '');
    }
    return out;
  }
}

/** Slack's three control characters. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

function shieldFencedCode(lines: readonly string[], shield: Shield): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const fence = FENCE_OPEN.exec(lines[i] ?? '')?.[1];
    if (!fence) {
      out.push(lines[i] ?? '');
      continue;
    }
    const body: string[] = [];
    const closing = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
    for (i += 1; i < lines.length && !closing.test(lines[i] ?? ''); i += 1) body.push(lines[i] ?? '');
    const code = body.join('\n').replace(/\n+$/, '');
    out.push(code ? shield.hide(`\`\`\`\n${escapeSlack(code)}\n\`\`\``) : '');
  }
  return out;
}

function shieldCode(text: string, shield: Shield): string {
  const fenced = shieldFencedCode(text.split('\n'), shield).join('\n');
  return fenced.replace(/(`+)([^`\n]+?)\1/g, (_m, _ticks, code: string) => shield.hide(`\`${escapeSlack(code)}\``));
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const TABLE_ROW = /^[^|\n]*\|.*$/;

function tableCells(row: string): string[] {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function convertTables(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const next = lines[i + 1] ?? '';
    if (!TABLE_ROW.test(line) || !next.includes('|') || !TABLE_SEPARATOR.test(next)) {
      out.push(line);
      continue;
    }
    out.push(`${BOLD}${tableCells(line).join(' | ')}${BOLD}`);
    i += 1;
    while (i + 1 < lines.length && TABLE_ROW.test(lines[i + 1] ?? '') && lines[i + 1]?.trim()) {
      i += 1;
      out.push(tableCells(lines[i] ?? '').join(' | '));
    }
  }
  return out;
}

const HEADING = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;
const SETEXT = /^ {0,3}(=+|-+)\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^(\s*)[-*+]\s+/;
const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+/;
const QUOTE = /^((?: {0,3}>\s?)+)(.*)$/;

function boldLine(content: string): string {
  const inner = content.replace(/\*\*|__/g, '').trim();
  return inner ? `${BOLD}${inner}${BOLD}` : '';
}

function convertBlocks(lines: string[], shield: Shield): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const previous = out.at(-1);
    const heading = HEADING.exec(line);
    const quote = QUOTE.exec(line);
    if (heading) out.push(boldLine(heading[1] ?? ''));
    else if (SETEXT.test(line) && previous?.trim() && !LIST_ITEM.test(previous) && !previous.startsWith(BOLD)) out[out.length - 1] = boldLine(previous);
    else if (RULE.test(line)) out.push('');
    else if (quote) out.push(`${shield.hide('>')} ${(quote[2] ?? '').replace(BULLET, '$1• ')}`);
    else out.push(line.replace(BULLET, '$1• '));
  }
  return out;
}

/** Link targets Slack may receive inside `<…>`; anything else there is a control sequence (`!channel`, `@U…`, `#C…`, `!subteam^…`). */
const LINK_TARGET = /^(?:https?:\/\/|mailto:)[^\s<>|]+$/i;

function link(url: string, label: string | undefined, shield: Shield): string {
  const trimmed = label?.trim() ?? '';
  if (!LINK_TARGET.test(url)) {
    // Not a web or mail link: plain escaped text, never `<…>` (an agent must not be able to ping @channel or a user).
    return shield.hide(escapeSlack(trimmed && trimmed !== url ? `${trimmed} (${url})` : url));
  }
  const target = escapeSlack(url);
  const text = trimmed ? escapeSlack(trimmed).replace(/\|/g, '¦') : '';
  return shield.hide(text && trimmed !== url ? `<${target}|${text}>` : `<${target}>`);
}

function convertInline(text: string, shield: Shield): string {
  const shielded = text
    .replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, (_m, ch: string) => shield.hide(escapeSlack(ch)))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, alt: string, url: string) => link(url, alt, shield))
    .replace(/\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, label: string, url: string) => link(url, label, shield))
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, (_m, url: string) => link(url, undefined, shield))
    .replace(/\bhttps?:\/\/[^\s<>()*~]*[^\s<>().,;:!?'"*_~]/g, (url) => link(url, undefined, shield));
  return escapeSlack(shielded)
    .replace(/\*\*\*(?=\S)([^\n]*?\S)\*\*\*/g, `${BOLD}_$1_${BOLD}`)
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, `${BOLD}$1${BOLD}`)
    .replace(/(^|[^\w])__(?=\S)([^\n]*?\S)__(?!\w)/g, `$1${BOLD}$2${BOLD}`)
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, '$1_$2_')
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, '~$1~');
}

export function toSlackMrkdwn(markdown: string): string {
  const shield = new Shield();
  const clean = markdown.replace(/\r\n?/g, '\n').replace(PRIVATE_USE, '');
  const withCode = shieldCode(clean, shield);
  const blocks = convertBlocks(convertTables(withCode.split('\n')), shield).join('\n');
  const inline = convertInline(blocks, shield).split(BOLD).join('*');
  return shield
    .restore(inline)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Plain text for Block Kit `plain_text` fields (no formatting; Slack escapes nothing there). */
export function toSlackPlain(markdown: string): string {
  return markdown
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
