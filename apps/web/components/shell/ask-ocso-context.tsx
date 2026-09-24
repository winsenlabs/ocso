'use client';

import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAskOcsoSession } from '@/components/internal-agent/use-ask-ocso-session';
import type { AskOcsoCopy } from './ask-ocso-copy';
import { AskOcsoDrawer } from './ask-ocso-drawer';

export const ASK_OCSO_DRAWER_ID = 'ask-ocso-drawer';
/** Query parameter that opens the drawer on a thread (links Ask OCSO sends into chat). */
export const THREAD_PARAM = 'askOcso';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A question handed to the drawer from elsewhere on the page (Home's Ask OCSO bar, a "needs you" item). */
export interface AskOcsoRequest {
  /** Increments per request so the same text asked twice is still a new request. */
  id: number;
  text: string;
  /** true: ask it now; false: put it in the ask box for the user to edit and send. */
  send: boolean;
}

interface AskOcsoState {
  open: boolean;
  toggle: () => void;
  close: () => void;
  /** Opens the drawer with a question, sent at once or left in the ask box. */
  ask: (text: string, options?: { send?: boolean }) => void;
  request: AskOcsoRequest | null;
  /** The drawer took the request (sent it or filled the box). */
  consumeRequest: (id: number) => void;
}

const AskOcsoContext = createContext<AskOcsoState | null>(null);

/** Open/closed state of the Ask OCSO drawer; ⌘J / Ctrl+J toggles it anywhere in the app. */
export function AskOcsoProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState<AskOcsoRequest | null>(null);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const close = useCallback(() => setOpen(false), []);
  const ask = useCallback((text: string, options?: { send?: boolean }) => {
    const question = text.trim();
    if (!question) return;
    setRequest((prev) => ({ id: (prev?.id ?? 0) + 1, text: question.slice(0, 4000), send: options?.send ?? false }));
    setOpen(true);
  }, []);
  const consumeRequest = useCallback((id: number) => setRequest((r) => (r?.id === id ? null : r)), []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        setOpen((o) => !o);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const value = useMemo(() => ({ open, toggle, close, ask, request, consumeRequest }), [open, toggle, close, ask, request, consumeRequest]);
  return <AskOcsoContext value={value}>{children}</AskOcsoContext>;
}

export function useAskOcso(): AskOcsoState {
  const state = use(AskOcsoContext);
  if (!state) throw new Error('useAskOcso must be used inside AskOcsoProvider');
  return state;
}

/**
 * Renders the drawer when open, with copy resolved from the session on the
 * server. The chat session lives here, not in the drawer, so closing and
 * reopening keeps the conversation.
 */
export function AskOcsoDrawerHost({ copy }: { copy: AskOcsoCopy }) {
  const { open, close, request, consumeRequest, toggle } = useAskOcso();
  const session = useAskOcsoSession();
  const { openThread } = session;
  // `?askOcso=<thread id>` (the "Open in OCSO" link Ask OCSO sends in Slack or Teams for a card that is finished
  // here): open the drawer on that thread, whose cards render with their current state. The parameter is removed.
  useEffect(() => {
    const url = new URL(window.location.href);
    const threadId = url.searchParams.get(THREAD_PARAM);
    if (!threadId) return;
    url.searchParams.delete(THREAD_PARAM);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    if (!UUID.test(threadId)) return;
    void openThread(threadId).then((found) => {
      if (found && !open) toggle();
    });
    // Once per page load: the parameter is gone after the first run.
  }, []);
  return open ? <AskOcsoDrawer id={ASK_OCSO_DRAWER_ID} copy={copy} session={session} onClose={close} request={request} onRequestHandled={consumeRequest} /> : null;
}
