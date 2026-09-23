/**
 * CommonMark-ish -> WhatsApp formatting (https://faq.whatsapp.com/539178204879377):
 * `**b**`/`__b__` -> `*b*`, `*i*`/`_i_` -> `_i_`, `~~s~~` -> `~s~`, fenced code
 * -> ```mono```, inline code kept, headings -> bold lines, tables -> readable
 * rows, links -> `text (url)`, rules dropped, bullets -> `- `.
 * Code and URLs are shielded with private-use placeholders so their `*`/`_`
 * are never reinterpreted. Mirrors the intent of the MIT-licensed
 * @chat-adapter/whatsapp converter without its markdown AST dependency.
 */

const PLACEHOLDER = /(\d+)/g;
const BOLD = '';
const PRIVATE_USE = /[-]/g;

class Shield {
  private readonly saved: string[] = [];

  hide(value: string): string {
    this.saved.push(value);
    return `${this.saved.length - 1}`;
  }

  restore(text: string): string {
    // Restored values may themselves contain placeholders (nested shields).
    let out = text;
    for (let pass = 0; pass < 3 && out.includes(''); pass += 1) {
      out = out.replace(PLACEHOLDER, (_, index: string) => this.saved[Number(index)] ?? '');
    }
    return out;
  }
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** Fenced blocks (``` or ~~~, unterminated runs to the end) become one ```mono``` placeholder. */
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
    out.push(code ? shield.hide(`\`\`\`${code}\`\`\``) : '');
  }
  return out;
}

function shieldCode(text: string, shield: Shield): string {
  const fenced = shieldFencedCode(text.split('\n'), shield).join('\n');
  return fenced.replace(/(`+)([^`\n]+?)\1/g, (_m, _ticks, code: string) => shield.hide(`\`${code}\``));
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
    i += 1; // skip separator
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
const BULLET = /^(\s*)[*+]\s+/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;

function boldLine(content: string): string {
  const inner = content.replace(/\*\*|__/g, '').trim();
  return inner ? `${BOLD}${inner}${BOLD}` : '';
}

function convertBlocks(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const previous = out.at(-1);
    const heading = HEADING.exec(line);
    if (heading) out.push(boldLine(heading[1] ?? ''));
    else if (SETEXT.test(line) && previous?.trim() && !LIST_ITEM.test(previous) && !previous.startsWith(BOLD)) {
      out[out.length - 1] = boldLine(previous);
    } else if (RULE.test(line)) out.push('');
    else out.push(line.replace(BULLET, '$1- '));
  }
  return out;
}

function convertInline(text: string, shield: Shield): string {
  return (
    text
      .replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, (_m, ch: string) => shield.hide(ch))
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, alt: string, url: string) =>
        alt.trim() ? `${alt.trim()} (${shield.hide(url)})` : shield.hide(url),
      )
      .replace(/\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, label: string, url: string) =>
        label.trim() === url ? shield.hide(url) : `${label} (${shield.hide(url)})`,
      )
      .replace(/<((?:https?|mailto):[^>\s]+)>/g, (_m, url: string) => shield.hide(url))
      .replace(/\b(?:https?:\/\/|www\.)[^\s<>()*~]*[^\s<>().,;:!?'"*_~]/g, (url) => shield.hide(url))
      // Order matters: ***bi*** before **b** before *i*. WhatsApp emphasis never
      // spans lines, so patterns are line-bounded (also keeps matching linear-ish).
      .replace(/\*\*\*(?=\S)([^\n]*?\S)\*\*\*/g, `${BOLD}_$1_${BOLD}`)
      .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, `${BOLD}$1${BOLD}`)
      .replace(/(^|[^\w])__(?=\S)([^\n]*?\S)__(?!\w)/g, `$1${BOLD}$2${BOLD}`)
      .replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, '$1_$2_')
      .replace(/~~(?=\S)([^\n]*?\S)~~/g, '~$1~')
  );
}

export function toWhatsAppText(markdown: string): string {
  const shield = new Shield();
  const clean = markdown.replace(/\r\n?/g, '\n').replace(PRIVATE_USE, '');
  const withCode = shieldCode(clean, shield);
  const blocks = convertBlocks(convertTables(withCode.split('\n'))).join('\n');
  const inline = convertInline(blocks, shield).split(BOLD).join('*');
  return shield
    .restore(inline)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
