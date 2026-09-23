'use client';

import type { AbortSignalLike, AttachmentInput, ChatState, ChoiceOption, CsatResult, OcsoChatClient, SendInput, UploadResult } from '@winsendotai/ocso-chat';
import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { useOcsoChatClient } from './context.js';

/**
 * Hooks over the headless client (shared by the web and React Native entries).
 */

/**
 * Subscribe to a slice of the chat state. The component re-renders only when
 * the selected value changes (`Object.is`, or your `isEqual`).
 */
export function useOcsoChatState<T>(selector: (state: ChatState) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const client = useOcsoChatClient();
  const cache = useRef<{ state: ChatState; value: T } | null>(null);
  const read = () => {
    const state = client.getState();
    const cached = cache.current;
    if (cached && cached.state === state) return cached.value;
    const value = selector(state);
    if (cached && isEqual(cached.value, value)) {
      cache.current = { state, value: cached.value };
      return cached.value;
    }
    cache.current = { state, value };
    return value;
  };
  return useSyncExternalStore(client.subscribe, read, read);
}

export interface UseOcsoChatResult {
  client: OcsoChatClient;
  state: ChatState;
  messages: ChatState['messages'];
  status: ChatState['status'];
  mode: ChatState['mode'];
  typing: ChatState['typing'];
  error: ChatState['error'];
  config: ChatState['config'];
  /** The composer's text (controlled). */
  input: string;
  setInput: (value: string) => void;
  /** Files staged for the next message. */
  attachments: AttachmentInput[];
  setAttachments: (files: AttachmentInput[]) => void;
  /** Send `input` (+ staged attachments) and clear them. Accepts a form event (calls preventDefault). */
  handleSubmit: (event?: { preventDefault?: () => void }) => Promise<void>;
  /** A send is in flight. */
  isSending: boolean;
  send: (input: SendInput) => Promise<void>;
  sendChoice: (choice: ChoiceOption) => Promise<void>;
  upload: (file: AttachmentInput, signal?: AbortSignalLike) => Promise<UploadResult>;
  retry: (messageId: string) => Promise<void>;
  discard: (messageId: string) => void;
  identify: (userToken: string) => Promise<void>;
  reset: () => Promise<void>;
  rateCsat: (score: 1 | 2 | 3 | 4 | 5, comment?: string) => Promise<CsatResult>;
  connect: () => Promise<void>;
  reconnect: () => void;
}

/** Everything a chat UI needs, Vercel-AI-SDK style (`messages`, `input`, `handleSubmit`…). */
export function useOcsoChat(): UseOcsoChatResult {
  const client = useOcsoChatClient();
  const state = useSyncExternalStore(client.subscribe, client.getState, client.getState);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<AttachmentInput[]>([]);
  const [inFlight, setInFlight] = useState(0);

  const track = useCallback(async (run: () => Promise<void>) => {
    setInFlight((n) => n + 1);
    try {
      await run();
    } finally {
      setInFlight((n) => n - 1);
    }
  }, []);

  const send = useCallback((value: SendInput) => track(() => client.send(value)), [client, track]);
  const sendChoice = useCallback((choice: ChoiceOption) => track(() => client.sendChoice(choice)), [client, track]);

  const handleSubmit = useCallback(
    async (event?: { preventDefault?: () => void }) => {
      event?.preventDefault?.();
      const text = input.trim();
      if (!text && !attachments.length) return;
      setInput('');
      setAttachments([]);
      // A failure is shown on the message itself (status 'failed' + retry), so it is not rethrown here.
      await send({ text, attachments }).catch(() => undefined);
    },
    [input, attachments, send],
  );

  return {
    client,
    state,
    messages: state.messages,
    status: state.status,
    mode: state.mode,
    typing: state.typing,
    error: state.error,
    config: state.config,
    input,
    setInput,
    attachments,
    setAttachments,
    handleSubmit,
    isSending: inFlight > 0,
    send,
    sendChoice,
    upload: useCallback((file: AttachmentInput, signal?: AbortSignalLike) => client.upload(file, signal), [client]),
    retry: useCallback((id: string) => client.retry(id), [client]),
    discard: useCallback((id: string) => client.discard(id), [client]),
    identify: useCallback((token: string) => client.identify(token), [client]),
    reset: useCallback(() => client.reset(), [client]),
    rateCsat: useCallback((score: 1 | 2 | 3 | 4 | 5, comment?: string) => client.rateCsat(score, comment), [client]),
    connect: useCallback(() => client.connect(), [client]),
    reconnect: useCallback(() => client.reconnect(), [client]),
  };
}

/** The choices of the latest message, if it asks a question (older questions are no longer actionable). */
export function latestChoices(messages: ChatState['messages']): { messageId: string; prompt?: string; options: ChoiceOption[] } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role === 'system') continue;
    if (m.role === 'customer') return null;
    const part = m.parts.find((p) => p.type === 'choices');
    if (part && part.type === 'choices') return { messageId: m.id, ...(part.prompt ? { prompt: part.prompt } : {}), options: part.options };
    return null;
  }
  return null;
}
