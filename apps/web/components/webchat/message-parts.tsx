'use client';

import { Fragment } from 'react';
import { kindOfMime } from '@/lib/webchat/files';
import { parseRichText, type Line } from '@/lib/webchat/rich-text';
import type { Translate } from '@/lib/webchat/strings';
import type { OcsoUIPart } from '@/lib/webchat/ui-messages';

/** Message body: safe rich text (React elements only) and attachment previews. */

function Inlines({ line }: { line: Line }) {
  return (
    <>
      {line.map((inline, i) => {
        const content = inline.segments.map((seg, j) =>
          seg.type === 'link' ? (
            <a key={j} href={seg.href} target="_blank" rel="noopener noreferrer nofollow ugc">
              {seg.text}
            </a>
          ) : (
            <Fragment key={j}>{seg.text}</Fragment>
          ),
        );
        if (inline.style === 'strong') return <strong key={i}>{content}</strong>;
        if (inline.style === 'em') return <em key={i}>{content}</em>;
        if (inline.style === 'code') return <code key={i}>{content}</code>;
        return <Fragment key={i}>{content}</Fragment>;
      })}
    </>
  );
}

export function RichText({ text }: { text: string }) {
  return (
    <>
      {parseRichText(text).map((block, i) => {
        if (block.type === 'ul' || block.type === 'ol') {
          const items = block.items.map((item, j) => (
            <li key={j}>
              <Inlines line={item} />
            </li>
          ));
          return block.type === 'ul' ? <ul key={i}>{items}</ul> : <ol key={i} start={block.start}>{items}</ol>;
        }
        return (
          <p key={i}>
            {block.lines.map((line, j) => (
              <Fragment key={j}>
                {j > 0 ? <br /> : null}
                <Inlines line={line} />
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}

const LABEL: Readonly<Record<ReturnType<typeof kindOfMime>, string>> = { image: 'IMG', audio: 'AUD', video: 'VID', pdf: 'PDF', file: 'FILE' };

export function Attachment({ part, t }: { part: OcsoUIPart; t: Translate }) {
  if (part.type === 'data-unavailable') {
    return (
      <span className="wc-file" aria-disabled="true">
        <span className="ic">{LABEL[kindOfMime(part.data.mediaType)]}</span>
        <span className="nm">{part.data.filename ?? t('attachment.unavailable')}</span>
      </span>
    );
  }
  if (part.type !== 'file') return null;
  const name = part.filename ?? part.mediaType;
  const kind = kindOfMime(part.mediaType);
  if (kind === 'image') {
    return (
      <a href={part.url} target="_blank" rel="noopener noreferrer" aria-label={t('attachment.open', { name })}>
        <img className="wc-img" src={part.url} alt={t('attachment.image', { name })} loading="lazy" referrerPolicy="no-referrer" />
      </a>
    );
  }
  if (kind === 'audio') {
    return <audio className="wc-audio" controls preload="metadata" src={part.url} aria-label={name} />;
  }
  return (
    <a className="wc-file" href={part.url} target="_blank" rel="noopener noreferrer" aria-label={t('attachment.open', { name })}>
      <span className="ic">{LABEL[kind]}</span>
      <span className="nm">{name}</span>
    </a>
  );
}
