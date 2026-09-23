import { linkify, type ChatMessage, type Part } from '@winsendotai/ocso-chat';
import type { ReactNode } from 'react';
export { defaultLabels, type OcsoChatLabels } from '../core/labels.js';

/** Class name slots every web component accepts (added next to the default `ocso-chat__*` classes). */
export interface OcsoChatClassNames {
  root?: string;
  header?: string;
  title?: string;
  subtitle?: string;
  banner?: string;
  log?: string;
  empty?: string;
  message?: string;
  bubble?: string;
  author?: string;
  part?: string;
  link?: string;
  media?: string;
  notice?: string;
  failed?: string;
  choices?: string;
  choice?: string;
  typing?: string;
  composer?: string;
  input?: string;
  attach?: string;
  send?: string;
  attachment?: string;
  error?: string;
  csat?: string;
}

export type RenderPart = (part: Part, message: ChatMessage, defaultRender: () => ReactNode) => ReactNode;
export type RenderMessage = (message: ChatMessage, defaultRender: () => ReactNode) => ReactNode;

export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ');
}

/** Text with http(s) links (never HTML). */
export function RichText({ text, linkClassName }: { text: string; linkClassName?: string | undefined }) {
  return (
    <>
      {linkify(text).map((seg, i) =>
        seg.type === 'link' ? (
          <a key={i} href={seg.href} target="_blank" rel="noopener noreferrer nofollow" className={cx('ocso-chat__link', linkClassName)}>
            {seg.text}
          </a>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}
