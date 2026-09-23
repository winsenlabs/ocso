'use client';

import type { ChatMessage, Part } from '@winsendotai/ocso-chat';
import { useEffect, useRef, type ReactNode } from 'react';
import { useOcsoChatClient } from '../core/context.js';
import { useOcsoChatState } from '../core/hooks.js';
import { ChoiceButtons } from './choice-buttons.js';
import { cx, defaultLabels, RichText, type OcsoChatClassNames, type OcsoChatLabels, type RenderMessage, type RenderPart } from './shared.js';

export interface MessageListProps {
  classNames?: OcsoChatClassNames;
  labels?: Partial<OcsoChatLabels>;
  renderMessage?: RenderMessage;
  renderPart?: RenderPart;
  /** Shown when there are no messages yet (e.g. the channel greeting). */
  empty?: ReactNode;
  /** Keep the newest message in view (default true). */
  autoScroll?: boolean;
}

function DefaultPart({ part, message, latest, classNames, labels }: { part: Part; message: ChatMessage; latest: boolean; classNames: OcsoChatClassNames | undefined; labels: OcsoChatLabels }) {
  const cls = cx('ocso-chat__part', `ocso-chat__part--${part.type}`, classNames?.part);
  switch (part.type) {
    case 'text':
      return (
        <p className={cls}>
          <RichText text={part.text} linkClassName={classNames?.link} />
        </p>
      );
    case 'media': {
      const media = cx('ocso-chat__media', classNames?.media);
      if (part.kind === 'image') return <img className={cx(cls, media)} src={part.url} alt={part.name ?? ''} loading="lazy" />;
      if (part.kind === 'audio') return <audio className={cx(cls, media)} src={part.url} controls preload="none" aria-label={part.name ?? 'Audio'} />;
      if (part.kind === 'video') return <video className={cx(cls, media)} src={part.url} controls preload="none" aria-label={part.name ?? 'Video'} />;
      return (
        <a className={cx(cls, media, 'ocso-chat__file')} href={part.url} target="_blank" rel="noopener noreferrer" download={part.name}>
          {part.name ?? 'Document'}
        </a>
      );
    }
    case 'choices':
      return (
        <div className={cls}>
          {part.prompt ? (
            <p className="ocso-chat__prompt">
              <RichText text={part.prompt} linkClassName={classNames?.link} />
            </p>
          ) : null}
          <ChoiceButtons key={message.id} options={part.options} prompt={part.prompt} disabled={!latest} {...(classNames ? { classNames } : {})} />
        </div>
      );
    case 'unavailable':
      return <p className={cx(cls, 'ocso-chat__unavailable')}>{labels.unavailable}</p>;
    default:
      return null;
  }
}

function authorLabel(message: ChatMessage, labels: OcsoChatLabels): string {
  if (message.role === 'customer') return labels.you;
  return message.author?.name ?? (message.role === 'agent' ? labels.agent : labels.assistant);
}

/** The conversation as an accessible log (`role="log"`, polite live region). */
export function MessageList({ classNames, labels: labelOverrides, renderMessage, renderPart, empty, autoScroll = true }: MessageListProps) {
  const client = useOcsoChatClient();
  const messages = useOcsoChatState((s) => s.messages);
  const labels = { ...defaultLabels, ...labelOverrides };
  const end = useRef<HTMLDivElement | null>(null);
  const last = messages[messages.length - 1];
  const lastText = last?.parts.map((p) => (p.type === 'text' ? p.text.length : 0)).join();

  useEffect(() => {
    if (autoScroll) end.current?.scrollIntoView?.({ block: 'end' });
  }, [autoScroll, messages.length, lastText]);

  const latestAnswerable = [...messages].reverse().find((m) => m.role !== 'system');

  const renderOne = (message: ChatMessage) => {
    const latest = message === latestAnswerable;
    const body = () => {
      if (message.role === 'system') {
        return (
          <p className={cx('ocso-chat__notice', classNames?.notice)}>
            {message.parts.map((p) => (p.type === 'text' ? p.text : '')).join(' ')}
          </p>
        );
      }
      return (
        <div className={cx('ocso-chat__bubble', classNames?.bubble)}>
          <span className={cx('ocso-chat__author', classNames?.author)}>{authorLabel(message, labels)}</span>
          {message.parts.map((part, i) => {
            const fallback = () => <DefaultPart part={part} message={message} latest={latest} classNames={classNames} labels={labels} />;
            return <span key={i} className="ocso-chat__part-wrap">{renderPart ? renderPart(part, message, fallback) : fallback()}</span>;
          })}
          {message.status === 'failed' ? (
            <span className={cx('ocso-chat__failed', classNames?.failed)} role="alert">
              {labels.failed}{' '}
              <button type="button" className="ocso-chat__link-button" onClick={() => void client.retry(message.id).catch(() => undefined)}>
                {labels.retry}
              </button>{' '}
              <button type="button" className="ocso-chat__link-button" onClick={() => client.discard(message.id)}>
                {labels.discard}
              </button>
            </span>
          ) : null}
        </div>
      );
    };
    return (
      <div
        key={message.id}
        className={cx('ocso-chat__message', `ocso-chat__message--${message.role}`, classNames?.message)}
        data-role={message.role}
        data-status={message.status}
        data-streaming={message.streaming ? 'true' : undefined}
        aria-busy={message.streaming || message.status === 'sending' ? true : undefined}
      >
        {renderMessage ? renderMessage(message, body) : body()}
      </div>
    );
  };

  return (
    <div role="log" aria-live="polite" aria-relevant="additions" aria-label={labels.log} tabIndex={0} className={cx('ocso-chat__log', classNames?.log)}>
      {messages.length === 0 && empty ? <div className={cx('ocso-chat__empty', classNames?.empty)}>{empty}</div> : null}
      {messages.map(renderOne)}
      <div ref={end} aria-hidden="true" />
    </div>
  );
}
