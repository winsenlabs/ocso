import { chatReducer, initialChatState, type ChatAction, type ChatState } from './state';

/**
 * Tiny external store around the canonical reducer so non-React code (the
 * transport, the live connection) can dispatch, and React subscribes with
 * useSyncExternalStore.
 */
export interface ChatStore {
  getState(): ChatState;
  dispatch(action: ChatAction): void;
  subscribe(listener: () => void): () => void;
}

export function createChatStore(initial: ChatState = initialChatState): ChatStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(action) {
      const next = chatReducer(state, action);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
