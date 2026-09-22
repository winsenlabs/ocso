'use client';

import { useEffect, useState } from 'react';
import type { LiveState } from '@/lib/webchat/live';
import { named, type Translate } from '@/lib/webchat/strings';
import type { ChatMode } from '@/lib/webchat/types';
import type { Phase } from './use-webchat';

/** Header and connection banner of the widget. */

function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '');
  return letters.join('') || '?';
}

export function ChatHeader({ title, subtitle, mode, humanName, t, onClose }: { title: string; subtitle: string | null; mode: ChatMode; humanName: string | null; t: Translate; onClose?: (() => void) | undefined }) {
  const status =
    mode === 'waiting'
      ? t('header.subtitle.waiting')
      : mode === 'human'
        ? t(named('header.subtitle.human', humanName), { name: humanName ?? '' })
        : mode === 'closed'
          ? t('header.subtitle.closed')
          : (subtitle ?? t('header.subtitle.ai'));
  return (
    <header className="wc-head">
      <span className={`wc-av${mode === 'human' ? ' human' : ''}`} aria-hidden="true">
        {initials(mode === 'human' && humanName ? humanName : title)}
      </span>
      <div className="wc-ttl">
        <h1>{title}</h1>
        <div className={`wc-sub ${mode}`} data-testid="wc-status">
          <span className="dot" aria-hidden="true" />
          <span>{status}</span>
        </div>
      </div>
      {onClose ? (
        <button type="button" className="wc-icon-btn" onClick={onClose} aria-label={t('header.close')}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
        </button>
      ) : null}
    </header>
  );
}

function useSecondsUntil(at: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!at) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [at]);
  return at ? Math.max(0, Math.ceil((at - now) / 1_000)) : null;
}

export function ConnectionBanner({ phase, live, t, onReconnect, onRestart }: { phase: Phase; live: LiveState; t: Translate; onReconnect: () => void; onRestart: () => void }) {
  const seconds = useSecondsUntil(live.status === 'reconnecting' ? live.retryAt : null);
  if (phase === 'failed') {
    return (
      <div className="wc-banner err" role="alert">
        <span className="grow">{t('status.sessionFailed')}</span>
        <button type="button" className="wc-link-btn" onClick={onRestart}>
          {t('status.retry')}
        </button>
      </div>
    );
  }
  if (phase !== 'ready') return null;
  if (live.status === 'offline') {
    return (
      <div className="wc-banner" role="status">
        <span className="grow">{t('status.offline')}</span>
      </div>
    );
  }
  // A first reconnect attempt is routine; only surface repeated failures.
  if (live.status === 'reconnecting' && live.attempt >= 2) {
    return (
      <div className="wc-banner" role="status">
        <span className="grow">{seconds ? t('status.reconnectingIn', { seconds }) : t('status.reconnecting')}</span>
        <button type="button" className="wc-link-btn" onClick={onReconnect}>
          {t('status.reconnect')}
        </button>
      </div>
    );
  }
  return null;
}
