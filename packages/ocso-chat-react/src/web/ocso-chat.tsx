'use client';

import type { ChatState, OcsoChatClient, OcsoChatOptions } from '@winsendotai/ocso-chat';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { OcsoChatProvider } from '../core/context.js';
import { useOcsoChat, useOcsoChatState } from '../core/hooks.js';
import { Composer } from './composer.js';
import { MessageList } from './message-list.js';
import { cx, defaultLabels, type OcsoChatClassNames, type OcsoChatLabels, type RenderMessage, type RenderPart } from './shared.js';
import { TypingIndicator } from './typing-indicator.js';

export interface OcsoChatPanelProps {
  classNames?: OcsoChatClassNames;
  labels?: Partial<OcsoChatLabels>;
  renderMessage?: RenderMessage;
  renderPart?: RenderPart;
  /** Header title (default: the channel's branding title, else its name). `null` hides the header. */
  title?: ReactNode | null;
  subtitle?: ReactNode;
  placeholder?: string;
  /** Ask for a 1–5 rating once the conversation is resolved (default true). */
  csat?: boolean;
  className?: string;
  style?: CSSProperties;
}

export type OcsoChatProps = OcsoChatPanelProps & {
  /** Use an existing client or provider instead (omit both inside an `OcsoChatProvider`). */
  client?: OcsoChatClient;
  options?: OcsoChatOptions;
};

function Banner({ status, labels, classNames, onRetry }: { status: ChatState['status']; labels: OcsoChatLabels; classNames: OcsoChatClassNames | undefined; onRetry: () => void }) {
  if (status !== 'reconnecting' && status !== 'offline' && status !== 'error') return null;
  const text = status === 'offline' ? labels.offline : status === 'error' ? labels.error : labels.reconnecting;
  return (
    <div role="status" className={cx('ocso-chat__banner', `ocso-chat__banner--${status}`, classNames?.banner)}>
      <span>{text}</span>
      {status !== 'offline' ? (
        <button type="button" className="ocso-chat__link-button" onClick={onRetry}>
          {labels.tryAgain}
        </button>
      ) : null}
    </div>
  );
}

function Csat({ labels, classNames }: { labels: OcsoChatLabels; classNames: OcsoChatClassNames | undefined }) {
  const chat = useOcsoChat();
  const [sent, setSent] = useState<number | null>(null);
  if (chat.mode !== 'resolved') return null;
  if (sent) return <p className={cx('ocso-chat__csat', classNames?.csat)} role="status">{labels.csatThanks}</p>;
  return (
    <div role="group" aria-label={labels.csatQuestion} className={cx('ocso-chat__csat', classNames?.csat)}>
      <span>{labels.csatQuestion}</span>
      {([1, 2, 3, 4, 5] as const).map((score) => (
        <button key={score} type="button" className="ocso-chat__csat-score" aria-label={labels.csatScore(score)} onClick={() => void chat.rateCsat(score).then(() => setSent(score), () => undefined)}>
          {score}
        </button>
      ))}
    </div>
  );
}

function Panel({ classNames, labels: labelOverrides, renderMessage, renderPart, title, subtitle, placeholder, csat = true, className, style }: OcsoChatPanelProps) {
  const labels = { ...defaultLabels, ...labelOverrides };
  const config = useOcsoChatState((s) => s.config);
  const status = useOcsoChatState((s) => s.status);
  const { reconnect } = useOcsoChat();
  const branding = config?.branding;
  const heading = title === undefined ? (branding?.title ?? config?.name ?? null) : title;
  const sub = subtitle ?? branding?.subtitle;
  const accent = branding?.accentColor ? ({ '--ocso-accent': branding.accentColor } as CSSProperties) : undefined;
  return (
    <section
      className={cx('ocso-chat', className, classNames?.root)}
      style={{ ...accent, ...style }}
      data-theme={branding?.theme && branding.theme !== 'auto' ? branding.theme : undefined}
      data-status={status}
      aria-label={typeof heading === 'string' ? heading : 'Chat'}
    >
      {heading !== null ? (
        <header className={cx('ocso-chat__header', classNames?.header)}>
          <h2 className={cx('ocso-chat__title', classNames?.title)}>{heading}</h2>
          {sub ? <p className={cx('ocso-chat__subtitle', classNames?.subtitle)}>{sub}</p> : null}
        </header>
      ) : null}
      <Banner status={status} labels={labels} classNames={classNames} onRetry={reconnect} />
      <MessageList
        {...(classNames ? { classNames } : {})}
        labels={labels}
        {...(renderMessage ? { renderMessage } : {})}
        {...(renderPart ? { renderPart } : {})}
        empty={branding?.greeting ? <p className="ocso-chat__greeting">{branding.greeting}</p> : null}
      />
      <TypingIndicator {...(classNames ? { classNames } : {})} label={labels.typing} />
      {csat ? <Csat labels={labels} classNames={classNames} /> : null}
      <Composer {...(classNames ? { classNames } : {})} labels={labels} {...(placeholder ? { placeholder } : {})} />
    </section>
  );
}

/**
 * The full chat panel: header, message log, typing indicator, CSAT prompt and
 * composer. Inside an `OcsoChatProvider` it uses that client; otherwise pass
 * `options` (or `client`) and it provides one itself.
 */
export function OcsoChat({ client, options, ...panel }: OcsoChatProps) {
  if (client) return <OcsoChatProvider client={client}><Panel {...panel} /></OcsoChatProvider>;
  if (options) return <OcsoChatProvider options={options}><Panel {...panel} /></OcsoChatProvider>;
  return <Panel {...panel} />;
}
