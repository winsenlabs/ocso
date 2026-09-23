import type { ChatMessage, ChatState, ChoiceOption, OcsoChatClient, SendInput } from '@winsendotai/ocso-chat';

/** Controllable in-memory OcsoChatClient for component tests. */
export function fakeClient(initial: Partial<ChatState> = {}) {
  let state: ChatState = {
    status: 'ready',
    mode: 'ai',
    messages: [],
    typing: null,
    notices: [],
    error: null,
    config: null,
    conversationId: null,
    agentName: 'Maya',
    humanName: null,
    authenticated: false,
    transport: 'sse',
    ...initial,
  };
  const listeners = new Set<(s: ChatState) => void>();
  const calls = {
    connect: 0,
    disconnect: 0,
    reconnect: 0,
    send: [] as SendInput[],
    sendChoice: [] as ChoiceOption[],
    retry: [] as string[],
    discard: [] as string[],
    csat: [] as number[],
  };
  const client: OcsoChatClient = {
    connect: async () => void calls.connect++,
    disconnect: () => void calls.disconnect++,
    reconnect: () => void calls.reconnect++,
    send: async (input) => void calls.send.push(input),
    sendChoice: async (choice) => void calls.sendChoice.push(choice),
    upload: async () => ({ uploadId: 'u', mimeType: 'image/png', sizeBytes: 1, filename: 'f' }),
    identify: async () => undefined,
    reset: async () => undefined,
    rateCsat: async (score) => (calls.csat.push(score), { recorded: true, score, receivedAt: '' }),
    retry: async (id) => void calls.retry.push(id),
    discard: (id) => void calls.discard.push(id),
    getState: () => state,
    subscribe: (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
    on: () => () => undefined,
  };
  return {
    client,
    calls,
    set(patch: Partial<ChatState>) {
      state = { ...state, ...patch };
      for (const fn of [...listeners]) fn(state);
    },
  };
}

export const msg = (m: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role'>): ChatMessage => ({ parts: [], createdAt: '2026-09-23T10:00:00Z', ...m });

export const text = (t: string) => ({ type: 'text' as const, text: t });

export const webConfig = {
  name: 'Site chat',
  assistantName: 'Maya',
  branding: { title: 'Meridian help', greeting: 'Hi! Ask us anything.', accentColor: '#123456', theme: 'light' as const, position: 'right' as const },
  inboundParts: ['TEXT', 'IMAGE'],
  maxMediaBytes: { IMAGE: 1000, AUDIO: 0, VIDEO: 0, DOCUMENT: 0 },
  allowedMimeTypes: { IMAGE: ['image/png'], AUDIO: [], VIDEO: [], DOCUMENT: [] },
  maxTextLength: 8000,
  maxAttachmentsPerMessage: 2,
  allowedOrigins: [],
  hostIdentity: false,
  authMode: 'anonymous' as const,
};
