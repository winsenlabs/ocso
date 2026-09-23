'use client';

import type { Chat } from '@ai-sdk/react';
import { useCallback, useMemo, useState } from 'react';
import type { ActionDecision } from '../../lib/actions/internal-agent';
import { createAskOcsoChat, type ChatStore } from './chat';
import type { PageContext } from './page-context';
import { DrawerStateSchema, ThreadHistorySchema, type AskOcsoMessage, type DrawerState, type ThreadHistory } from './types';

/**
 * Ask OCSO session: one chat (AI SDK `Chat`), the thread it continues, and
 * the drawer's server state. It lives in the always-mounted drawer host, so
 * closing the drawer (⌘J / Esc) keeps the conversation — and an answer still
 * streaming — intact.
 */

export type DrawerLoad = { status: 'loading' } | { status: 'ready'; data: DrawerState } | { status: 'error'; httpStatus: number | null };

export interface AskOcsoSession {
  chat: Chat<AskOcsoMessage>;
  threadId: string | null;
  load: DrawerLoad;
  /** ms from send to the end of each answer, by assistant message id (live answers only). */
  durations: ReadonlyMap<string, number>;
  /** Assistant messages the user stopped. */
  stopped: ReadonlySet<string>;
  decisions: ReadonlyMap<string, ActionDecision>;
  refresh(): Promise<void>;
  send(text: string, context: PageContext | null): void;
  /** Ask the last question again (same thread, same page context). */
  retry(): void;
  openThread(id: string): Promise<boolean>;
  newThread(): void;
  decide(actionId: string, decision: ActionDecision): void;
}

export function useAskOcsoSession(): AskOcsoSession {
  // Mutable per-session request state read by the transport; changes need no re-render.
  const [store] = useState<ChatStore>(() => ({ threadId: null, context: null, sentAt: 0 }));
  const [threadId, setThreadId] = useState<string | null>(null);
  const [load, setLoad] = useState<DrawerLoad>({ status: 'loading' });
  const [durations, setDurations] = useState<ReadonlyMap<string, number>>(new Map());
  const [stopped, setStopped] = useState<ReadonlySet<string>>(new Set());
  const [decisions, setDecisions] = useState<ReadonlyMap<string, ActionDecision>>(new Map());

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/internal-agent', { cache: 'no-store' });
      if (!res.ok) return setLoad({ status: 'error', httpStatus: res.status });
      setLoad({ status: 'ready', data: DrawerStateSchema.parse(await res.json()) });
    } catch {
      setLoad({ status: 'error', httpStatus: null });
    }
  }, []);

  const [chat] = useState(() =>
    createAskOcsoChat({
      store,
      onThread: setThreadId,
      onFinish: ({ message, isAbort, isError }) => {
        if (message.role !== 'assistant') return;
        const ms = performance.now() - store.sentAt;
        setDurations((d) => new Map(d).set(message.id, ms));
        if (isAbort) setStopped((s) => new Set(s).add(message.id));
        if (!isError) void refresh();
      },
    }),
  );

  const send = useCallback(
    (text: string, context: PageContext | null) => {
      store.context = context;
      store.sentAt = performance.now();
      void chat.sendMessage({ text });
    },
    [chat, store],
  );

  const retry = useCallback(() => {
    store.sentAt = performance.now();
    void chat.regenerate();
  }, [chat, store]);

  const reset = useCallback(
    (id: string | null, messages: AskOcsoMessage[]) => {
      chat.clearError();
      chat.messages = messages;
      store.threadId = id;
      setThreadId(id);
    },
    [chat, store],
  );

  const openThread = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/internal-agent/threads/${encodeURIComponent(id)}`, { cache: 'no-store' });
        if (!res.ok) return false;
        const history = ThreadHistorySchema.parse(await res.json()) as ThreadHistory;
        reset(history.threadId, history.messages);
        return true;
      } catch {
        return false;
      }
    },
    [reset],
  );

  const newThread = useCallback(() => reset(null, []), [reset]);
  const decide = useCallback((actionId: string, decision: ActionDecision) => setDecisions((d) => new Map(d).set(actionId, decision)), []);

  return useMemo(
    () => ({ chat, threadId, load, durations, stopped, decisions, refresh, send, retry, openThread, newThread, decide }),
    [chat, threadId, load, durations, stopped, decisions, refresh, send, retry, openThread, newThread, decide],
  );
}
