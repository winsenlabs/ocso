'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { WebChatApiError } from '@/lib/webchat/api';
import type { HostCommand } from '@/lib/webchat/bridge';
import { named, pickLocale, translator, type Translate } from '@/lib/webchat/strings';
import type { WebChatConfig } from '@/lib/webchat/types';
import { ChatHeader, ConnectionBanner } from './chat-chrome';
import { ChatUnavailable } from './chat-unavailable';
import { Composer, type ComposerHandle } from './composer';
import { MessageLog, noticeText } from './message-log';
import { useHostBridge } from './use-host-bridge';
import { useWebChat, type Incoming } from './use-webchat';

/** Customer web chat (docs/07 §4): the page inside the embed iframe, or standalone at /chat/:publicKey. */

/** Readable text colour on the brand accent (WCAG relative luminance). */
function onAccent(hex: string): string {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.42 ? '#111418' : '#ffffff';
}

function describe(incoming: Incoming, t: Translate): string {
  if (incoming.kind === 'notice') return noticeText(incoming.notice, t);
  const m = incoming.message;
  const author = m.from === 'human' ? t(named('author.human', m.name), { name: m.name ?? '' }) : t(named('author.assistant', m.name), { name: m.name ?? '' });
  const text = m.parts.map((p) => (p.type === 'TEXT' ? p.text : '')).join(' ').trim().slice(0, 300);
  return `${t('a11y.newMessage', { author })}: ${text}`;
}

export function WebChatApp({ publicKey, config }: { publicKey: string; config: WebChatConfig }) {
  const [locale, setLocale] = useState('en');
  const t = useMemo(() => translator(locale), [locale]);
  const [announcement, setAnnouncement] = useState('');
  const [unread, setUnread] = useState(0);
  const openRef = useRef(false);
  const composer = useRef<ComposerHandle>(null);

  const chat = useWebChat(publicKey, {
    onIncoming: (incoming) => {
      if (!openRef.current || document.hidden) setUnread((n) => n + 1);
      setAnnouncement(describe(incoming, t));
    },
  });
  const { branding } = config;
  const title = branding.title ?? chat.state.agentName ?? config.assistantName ?? config.name;

  const onCommand = (command: HostCommand) => {
    if (command.type === 'open') chat.activate();
    if (command.type === 'identify') {
      chat.identify(command.token).then(
        () => host.post({ type: 'identified', ok: true, requestId: command.requestId }),
        (err: unknown) => host.post({ type: 'identified', ok: false, requestId: command.requestId, error: err instanceof WebChatApiError ? err.code : 'identify_failed' }),
      );
    }
    if (command.type === 'reset') void chat.resetVisitor().catch(() => undefined);
  };
  const host = useHostBridge({ config, onCommand });
  openRef.current = host.open;

  useEffect(() => setLocale(pickLocale(navigator.languages)), []);

  // Start the session when the widget is used: always standalone; when embedded, once opened
  // or when this visitor has an earlier session (so replies to them still arrive and badge).
  const { activate, hasStoredSession } = chat;
  useEffect(() => {
    if (host.embedding === 'pending' || host.embedding === 'blocked') return;
    if (host.embedding !== 'managed' || host.open || hasStoredSession()) activate();
  }, [host.embedding, host.open, activate, hasStoredSession]);

  useEffect(() => {
    if (!host.open) return;
    setUnread(0);
    composer.current?.focus();
  }, [host.open]);

  const { post, embedding } = host;
  useEffect(() => {
    if (embedding === 'managed') post({ type: 'unread', count: unread });
  }, [unread, embedding, post]);

  useEffect(() => {
    const root = document.documentElement;
    if (branding.theme !== 'auto') {
      root.setAttribute('data-theme', branding.theme);
      return;
    }
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => root.setAttribute('data-theme', media.matches ? 'dark' : 'light');
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [branding.theme]);

  if (host.embedding === 'blocked') return <ChatUnavailable t={t} />;

  const style = branding.accentColor ? ({ '--wc-accent': branding.accentColor, '--wc-on-accent': onAccent(branding.accentColor) } as CSSProperties) : undefined;
  const { state } = chat;
  const agentName = state.agentName ?? config.assistantName;
  const placeholder = state.mode === 'human' && state.humanName ? t('composer.placeholderHuman', { name: state.humanName }) : t('composer.placeholder');

  return (
    <div
      className="wc"
      style={style}
      data-mode={state.mode}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && host.embedding === 'managed') host.requestClose();
      }}
    >
      <ChatHeader title={title} subtitle={branding.subtitle ?? null} mode={state.mode} humanName={state.humanName} t={t} onClose={host.embedding === 'managed' ? host.requestClose : undefined} />
      <ConnectionBanner phase={chat.phase} live={chat.live} t={t} onReconnect={chat.reconnect} onRestart={() => void chat.restart()} />
      <MessageLog
        messages={chat.messages}
        typing={state.typing}
        agentName={agentName}
        greeting={branding.greeting ?? null}
        loading={chat.phase === 'starting' && !state.loaded}
        locale={locale}
        t={t}
        onRetry={chat.retry}
        onDiscard={chat.discard}
      />
      <Composer ref={composer} config={config} placeholder={placeholder} t={t} onSend={(text, attachments) => void chat.send(text, attachments)} upload={chat.upload} />
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}
