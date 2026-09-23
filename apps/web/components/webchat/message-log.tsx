'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { named, type Translate } from '@/lib/webchat/strings';
import type { ChatState } from '@/lib/webchat/state';
import type { NoticeKind } from '@/lib/webchat/types';
import type { OcsoUIMessage } from '@/lib/webchat/ui-messages';
import { Attachment, RichText } from './message-parts';

/**
 * The conversation log. New messages are announced through the app's own
 * polite live region (not this list), so streamed drafts do not flood screen
 * readers; the list itself is a labelled log without live announcements.
 */

export interface MessageLogProps {
  messages: OcsoUIMessage[];
  typing: ChatState['typing'];
  agentName: string | null;
  greeting: string | null;
  loading: boolean;
  locale: string;
  t: Translate;
  onRetry: (clientMessageId: string) => void;
  onDiscard: (clientMessageId: string) => void;
  /** The customer tapped an option of the latest question (sent as their reply). */
  onChoose?: ((label: string) => void) | undefined;
}

const GROUP_GAP_MS = 5 * 60_000;

export function noticeText(notice: { kind: NoticeKind; name: string | null } | null, t: Translate): string {
  if (!notice) return '';
  if (notice.kind === 'joined') return t(named('notice.joined', notice.name), { name: notice.name ?? '' });
  if (notice.kind === 'ai_resumed') return t(named('notice.ai_resumed', notice.name), { name: notice.name ?? '' });
  return t(notice.kind === 'waiting' ? 'notice.waiting' : 'notice.resolved');
}

export function authorLabel(meta: NonNullable<OcsoUIMessage['metadata']>, t: Translate): string {
  if (meta.author === 'customer') return t('author.you');
  if (meta.author === 'human') return t(named('author.human', meta.name), { name: meta.name ?? '' });
  return t(named('author.assistant', meta.name), { name: meta.name ?? '' });
}

function timeOf(iso: string | null, locale: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date);
}

function startsGroup(message: OcsoUIMessage, previous: OcsoUIMessage | undefined): boolean {
  const a = message.metadata;
  const b = previous?.metadata;
  if (!a || !b || b.kind === 'notice') return true;
  if (a.author !== b.author || a.name !== b.name) return true;
  const gap = a.at && b.at ? Date.parse(a.at) - Date.parse(b.at) : 0;
  return gap > GROUP_GAP_MS;
}

function Message({ message, first, latest, locale, t, onRetry, onDiscard, onChoose }: { message: OcsoUIMessage; first: boolean; latest: boolean } & Pick<MessageLogProps, 'locale' | 't' | 'onRetry' | 'onDiscard' | 'onChoose'>) {
  const meta = message.metadata;
  if (!meta) return null;
  if (meta.kind === 'notice') {
    return (
      <div className={`wc-notice ${meta.notice?.kind ?? ''}`}>
        <span>{noticeText(meta.notice, t)}</span>
      </div>
    );
  }
  const side = meta.author === 'customer' ? 'me' : meta.author === 'human' ? 'hum' : 'ai';
  const failed = meta.delivery === 'failed';
  const text = message.parts.filter((p) => p.type === 'text');
  const files = message.parts.filter((p) => p.type === 'file' || p.type === 'data-unavailable');
  const streaming = text.some((p) => p.type === 'text' && p.state === 'streaming');
  const choices = message.parts.flatMap((p) => (p.type === 'data-choices' ? p.data.options : []));
  const clientId = meta.clientMessageId;
  return (
    <div className={`wc-row ${side}${first ? ' first' : ''}${failed ? ' failed' : ''}`} data-author={meta.author}>
      {first ? <div className={side === 'me' ? 'wc-author sr-only' : 'wc-author'}>{authorLabel(meta, t)}</div> : <div className="sr-only">{authorLabel(meta, t)}</div>}
      <div className={`wc-bubble${streaming ? ' streaming' : ''}`}>
        {files.length ? (
          <div className="wc-files">
            {files.map((part, i) => (
              <Attachment key={i} part={part} t={t} />
            ))}
          </div>
        ) : null}
        {text.map((part, i) => (part.type === 'text' ? <RichText key={i} text={part.text} /> : null))}
      </div>
      {choices.length ? (
        <div className="wc-choices" role="group" aria-label={t('choices.label')}>
          {choices.map((option) => (
            <button key={option.id} type="button" className="wc-choice" disabled={!latest || !onChoose} onClick={() => onChoose?.(option.label)}>
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
      {meta.kind === 'message' ? (
        <div className="wc-meta">
          <span>{timeOf(meta.at, locale)}</span>
          {meta.delivery ? <span className={failed ? 'bad' : undefined}>{t(`delivery.${meta.delivery}`)}</span> : null}
          {failed && clientId ? (
            <>
              <button type="button" className="wc-link-btn" onClick={() => onRetry(clientId)}>
                {t('delivery.retry')}
              </button>
              <button type="button" className="wc-link-btn" onClick={() => onDiscard(clientId)}>
                {t('delivery.discard')}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function MessageLog({ messages, typing, agentName, greeting, loading, locale, t, onRetry, onDiscard, onChoose }: MessageLogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const streamingTurn = messages.some((m) => m.metadata?.kind === 'draft');
  const showTyping = Boolean(typing) && !streamingTurn;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    const last = messages.at(-1);
    // Follow new content while the reader is at the bottom — and always after the customer's own message.
    if (el && (pinned.current || last?.metadata?.author === 'customer')) el.scrollTop = el.scrollHeight;
  }, [messages, showTyping]);

  const typingText = typing?.status === 'CALLING_TOOL' ? t(named('typing.tool', agentName), { name: agentName ?? '' }) : t(named('typing.assistant', agentName), { name: agentName ?? '' });

  return (
    <div className="wc-log" ref={ref} role="log" aria-live="off" aria-label={t('log.label')} tabIndex={0} aria-busy={loading}>
      {greeting ? <div className="wc-greeting">{greeting}</div> : null}
      {loading && messages.length === 0 ? <div className="wc-empty">{t('log.loading')}</div> : null}
      {!loading && !greeting && messages.length === 0 ? <div className="wc-empty">{t('log.empty')}</div> : null}
      {messages.map((message, i) => (
        <Message
          key={message.id}
          message={message}
          first={startsGroup(message, messages[i - 1])}
          // Options answer only the latest question: once the customer wrote again they are history.
          latest={messages.slice(i + 1).every((m) => m.metadata?.kind === 'notice')}
          locale={locale}
          t={t}
          onRetry={onRetry}
          onDiscard={onDiscard}
          onChoose={onChoose}
        />
      ))}
      {showTyping ? (
        <div className="wc-typing" data-testid="wc-typing">
          <span className="wc-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>{typingText}</span>
        </div>
      ) : null}
    </div>
  );
}
