import { Fragment, type ReactNode } from 'react';

/**
 * The agent's answer text (design/05 `.ans`). Models write light Markdown;
 * this renders just paragraphs, bullet lists, **bold** and `code` as React
 * elements — never as HTML — and shows anything else verbatim.
 */

type Block = { kind: 'p'; lines: string[] } | { kind: 'ul'; items: string[] };

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

export function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const last = blocks.at(-1);
    if (!line.trim()) {
      if (last) blocks.push({ kind: 'p', lines: [] });
      continue;
    }
    if (BULLET.test(line)) {
      const item = line.replace(BULLET, '').replace(/^#+\s*/, '');
      if (last?.kind === 'ul') last.items.push(item);
      else blocks.push({ kind: 'ul', items: [item] });
    } else if (last?.kind === 'p') {
      last.lines.push(line.replace(/^#+\s*/, ''));
    } else {
      blocks.push({ kind: 'p', lines: [line.replace(/^#+\s*/, '')] });
    }
  }
  return blocks.filter((b) => (b.kind === 'p' ? b.lines.length > 0 : b.items.length > 0));
}

/** **bold** and `code` inline; everything else as plain text. */
export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > at) out.push(text.slice(at, match.index));
    out.push(match[1] !== undefined ? <b key={match.index}>{match[1]}</b> : <code key={match.index}>{match[2]}</code>);
    at = match.index + match[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

export function AnswerText({ text, streaming }: { text: string; streaming: boolean }) {
  const blocks = splitBlocks(text);
  // The streaming caret sits at the end of the last line written so far.
  const caret = (last: boolean) => (streaming && last ? <span className="ia-caret" aria-hidden="true" /> : null);
  return (
    <div className="ans ia-ans">
      {blocks.map((b, i) =>
        b.kind === 'ul' ? (
          <ul key={i}>
            {b.items.map((item, j) => (
              <li key={j}>
                {inline(item)}
                {caret(i === blocks.length - 1 && j === b.items.length - 1)}
              </li>
            ))}
          </ul>
        ) : (
          <p key={i}>
            {b.lines.map((line, j) => (
              <Fragment key={j}>
                {j > 0 ? <br /> : null}
                {inline(line)}
              </Fragment>
            ))}
            {caret(i === blocks.length - 1)}
          </p>
        ),
      )}
    </div>
  );
}
