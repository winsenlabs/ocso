'use client';

import { useChat } from '@ai-sdk/react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { WebChatApi } from '@/lib/webchat/api';
import { LiveConnection, type LiveState } from '@/lib/webchat/live';
import { lazyBrowserStorage, VisitorSession } from '@/lib/webchat/session';
import type { LocalAttachment, PendingSend } from '@/lib/webchat/state';
import { createChatStore, type ChatStore } from '@/lib/webchat/store';
import { OcsoChatTransport } from '@/lib/webchat/transport';
import type { LiveEvent, WebChatMessage, WebChatNotice } from '@/lib/webchat/types';
import { fromPending, toUIMessages, type OcsoUIMessage } from '@/lib/webchat/ui-messages';

/**
 * Wires one widget instance: visitor session → live stream → canonical store
 * → `useChat` (via OcsoChatTransport). The store is the source of truth and is
 * mirrored into useChat's message list, which the widget renders.
 */

export type Phase = 'idle' | 'starting' | 'ready' | 'failed';
export type Incoming = { kind: 'message'; message: WebChatMessage } | { kind: 'notice'; notice: WebChatNotice };

interface Services {
  api: WebChatApi;
  session: VisitorSession;
  store: ChatStore;
  transport: OcsoChatTransport;
  live: LiveConnection;
  /** Fetch what the store lacks: the latest page first, then pages after the last seen seq. */
  gapFill: () => Promise<void>;
}

/** 8–128 url-safe chars (the API's clientMessageId rule); works outside secure contexts too. */
export function randomId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const HISTORY_PAGE = 200;

export function useWebChat(publicKey: string, options: { onIncoming: (incoming: Incoming) => void }) {
  const onIncoming = useRef(options.onIncoming);
  onIncoming.current = options.onIncoming;
  const [phase, setPhase] = useState<Phase>('idle');
  const [live, setLive] = useState<LiveState>({ status: 'connecting', attempt: 0, retryAt: null });

  const [services] = useState<Services>(() => {
    const api = new WebChatApi(publicKey);
    const session = new VisitorSession(api, lazyBrowserStorage());
    const store = createChatStore();
    let liveRef: LiveConnection | null = null;
    const transport = new OcsoChatTransport({ api, session, store, live: () => liveRef });
    const gapFill = async () => {
      const token = session.token;
      if (!token) return;
      for (let page = 0; page < 5; page++) {
        const after = store.getState().lastSeq;
        const history = await api.history(token, after);
        store.dispatch({ type: 'history', history, mode: after === 0 ? 'replace' : 'merge' });
        if (after === 0 || history.messages.length < HISTORY_PAGE) break;
      }
    };
    const onEvent = (event: LiveEvent) => {
      const now = Date.now();
      switch (event.event) {
        case 'ready':
          void gapFill().catch(() => undefined);
          break;
        case 'message':
          store.dispatch({ type: 'message', message: event.data });
          if (event.data.from !== 'customer') onIncoming.current({ kind: 'message', message: event.data });
          break;
        case 'delta':
          store.dispatch({ type: 'delta', turnId: event.data.turnId, text: event.data.text, now });
          break;
        case 'typing':
          store.dispatch({ type: 'typing', turnId: event.data.turnId, status: event.data.status ?? null, now });
          break;
        case 'idle':
          store.dispatch({ type: 'idle', turnId: event.data.turnId });
          break;
        case 'notice':
          if (!store.getState().notices.some((n) => n.id === event.data.id)) onIncoming.current({ kind: 'notice', notice: event.data });
          store.dispatch({ type: 'notice', notice: event.data });
          break;
        case 'status':
          store.dispatch({ type: 'status', status: event.data });
          break;
        default:
          break;
      }
    };
    liveRef = new LiveConnection({
      url: api.streamUrl(),
      token: () => session.token,
      onUnauthorized: async () => void (await session.refresh()),
      onEvent,
      onState: (state) => setLive(state),
    });
    return { api, session, store, transport, live: liveRef, gapFill };
  });
  const { gapFill } = services;

  const state = useSyncExternalStore(services.store.subscribe, services.store.getState, services.store.getState);
  const uiMessages = useMemo(() => toUIMessages(state), [state]);
  const chat = useChat<OcsoUIMessage>({ id: `ocso-webchat:${publicKey}`, transport: services.transport });
  const { setMessages, sendMessage } = chat;
  useEffect(() => setMessages(uiMessages), [uiMessages, setMessages]);

  const started = useRef(false);
  const start = useCallback(async () => {
    started.current = true;
    setPhase('starting');
    try {
      await services.session.start();
      services.live.start();
      await gapFill();
      setPhase('ready');
    } catch {
      setPhase('failed');
    }
  }, [services, gapFill]);

  /** Start once the widget is actually used (opened, resumed or identified). */
  const activate = useCallback(() => {
    if (!started.current) void start();
  }, [start]);

  useEffect(() => {
    const tick = setInterval(() => services.store.dispatch({ type: 'tick', now: Date.now() }), 5_000);
    return () => {
      clearInterval(tick);
      services.live.stop();
      started.current = false;
    };
  }, [services]);

  const send = useCallback(
    async (text: string, attachments: LocalAttachment[]) => {
      const pending: PendingSend = { clientMessageId: randomId('cm_'), text, attachments, status: 'sending', at: new Date().toISOString() };
      services.store.dispatch({ type: 'send', pending });
      if (!started.current) void start();
      await sendMessage(fromPending(pending));
    },
    [services, sendMessage, start],
  );

  const retry = useCallback(
    (clientMessageId: string) => {
      const pending = services.store.getState().pending.find((p) => p.clientMessageId === clientMessageId);
      if (!pending) return;
      services.store.dispatch({ type: 'retry', clientMessageId });
      void services.transport.deliver(fromPending({ ...pending, status: 'sending' })).catch(() => undefined);
    },
    [services],
  );

  const discard = useCallback(
    (clientMessageId: string) => {
      const pending = services.store.getState().pending.find((p) => p.clientMessageId === clientMessageId);
      for (const a of pending?.attachments ?? []) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      services.store.dispatch({ type: 'discard', clientMessageId });
    },
    [services],
  );

  /** Swap identity (host JWT or logout): the conversation shown may change entirely. */
  const switchIdentity = useCallback(
    async (change: () => Promise<unknown>) => {
      await change();
      services.store.dispatch({ type: 'reset' });
      if (!started.current) return start();
      services.live.reconnectNow();
      await gapFill();
    },
    [services, gapFill, start],
  );

  const reconnect = useCallback(() => void chat.resumeStream(), [chat.resumeStream]);
  const hasStoredSession = useCallback(() => services.session.hasStored(), [services]);
  const identify = useCallback((hostToken: string) => switchIdentity(() => services.session.identify(hostToken)), [services, switchIdentity]);
  const resetVisitor = useCallback(() => switchIdentity(() => services.session.reset()), [services, switchIdentity]);
  const upload = useCallback(
    async (file: File, onProgress: (ratio: number) => void, signal: AbortSignal) => {
      const token = services.session.token ?? (await services.session.start()).token;
      return services.api.upload(token, file, onProgress, signal);
    },
    [services],
  );

  return {
    state,
    messages: chat.messages,
    chatStatus: chat.status,
    phase,
    live,
    activate,
    restart: start,
    send,
    retry,
    discard,
    /** Reconnect the live stream now (useChat.resumeStream → the transport's reconnectToStream). */
    reconnect,
    hasStoredSession,
    identify,
    resetVisitor,
    upload,
  };
}

export type WebChatController = ReturnType<typeof useWebChat>;
