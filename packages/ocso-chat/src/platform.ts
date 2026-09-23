import type { AbortSignalLike, ChatStorage, FetchLike } from './types.js';

export type { AbortSignalLike };

/**
 * Feature-detected platform access. The core never touches DOM types: every
 * global is looked up at runtime so the same code runs in browsers, React
 * Native and Node.
 */

type TimerId = unknown;
interface Globals {
  setTimeout(fn: () => void, ms: number): TimerId;
  clearTimeout(id: TimerId): void;
  setInterval(fn: () => void, ms: number): TimerId;
  clearInterval(id: TimerId): void;
  fetch?: FetchLike;
  crypto?: { getRandomValues?<T extends Uint8Array>(array: T): T };
  localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
  URL?: { createObjectURL?(blob: unknown): string; revokeObjectURL?(url: string): void };
  addEventListener?(type: string, fn: () => void): void;
  removeEventListener?(type: string, fn: () => void): void;
  navigator?: { onLine?: boolean; product?: string };
  AbortController?: new () => AbortControllerLike;
  ReadableStream?: unknown;
}

export interface AbortControllerLike {
  readonly signal: AbortSignalLike;
  abort(reason?: unknown): void;
}

const g = globalThis as unknown as Globals;

export const timers = {
  set: (fn: () => void, ms: number): TimerId => g.setTimeout(fn, ms),
  clear: (id: TimerId | null | undefined): void => {
    if (id !== null && id !== undefined) g.clearTimeout(id);
  },
  every: (fn: () => void, ms: number): TimerId => g.setInterval(fn, ms),
  stop: (id: TimerId | null | undefined): void => {
    if (id !== null && id !== undefined) g.clearInterval(id);
  },
};

export function sleep(ms: number, signal?: AbortSignalLike): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const id = timers.set(resolve, ms);
    signal?.addEventListener('abort', () => {
      timers.clear(id);
      reject(abortError());
    }, { once: true });
  });
}

export function abortError(message = 'Aborted'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export function newAbortController(): AbortControllerLike {
  if (!g.AbortController) throw new Error('AbortController is not available on this platform');
  return new g.AbortController();
}

export function platformFetch(): FetchLike {
  const f = g.fetch;
  if (!f) throw new Error('fetch is not available on this platform: pass options.fetch');
  return (input, init) => f.call(globalThis, input, init);
}

/** 8–128 url-safe chars (the API's clientMessageId rule). */
export function randomId(prefix: string): string {
  const bytes = new Uint8Array(16);
  if (g.crypto?.getRandomValues) g.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function memoryStorage(): ChatStorage {
  const map = new Map<string, string>();
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
    remove: (k) => void map.delete(k),
  };
}

/** localStorage when present and writable (not in private mode), else memory. Resolved lazily. */
export function defaultStorage(): ChatStorage {
  let resolved: ChatStorage | null = null;
  const get = (): ChatStorage => {
    if (resolved) return resolved;
    try {
      // Node ≥ 22 exposes a localStorage that only works with --localstorage-file: use memory there.
      const nodeWithoutDom = typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node === 'string' && typeof (globalThis as { document?: unknown }).document === 'undefined';
      const ls = nodeWithoutDom ? undefined : g.localStorage;
      if (ls) {
        const probe = '__ocso_chat_probe__';
        ls.setItem(probe, '1');
        ls.removeItem(probe);
        resolved = { get: (k) => ls.getItem(k), set: (k, v) => ls.setItem(k, v), remove: (k) => ls.removeItem(k) };
        return resolved;
      }
    } catch {
      // Blocked storage: fall through to memory.
    }
    resolved = memoryStorage();
    return resolved;
  };
  return { get: (k) => get().get(k), set: (k, v) => get().set(k, v), remove: (k) => get().remove(k) };
}

export function objectUrl(blob: unknown): string | undefined {
  try {
    return g.URL?.createObjectURL?.(blob);
  } catch {
    return undefined;
  }
}

export function revokeObjectUrl(url: string | undefined): void {
  if (url?.startsWith('blob:')) {
    try {
      g.URL?.revokeObjectURL?.(url);
    } catch {
      // ignore
    }
  }
}

export function isOffline(): boolean {
  return g.navigator?.onLine === false && g.navigator.product !== 'ReactNative';
}

/**
 * Whether the platform `fetch` can hand over a response body before it is
 * complete. Decided BEFORE opening the stream: React Native's fetch
 * (whatwg-fetch over XHR) only resolves once the body has fully arrived, which
 * an SSE response never does, so asking it for `/stream` would hang.
 */
export function canStreamResponses(): boolean {
  if (g.navigator?.product === 'ReactNative') return false;
  return typeof g.ReadableStream === 'function';
}

/** Browser `online` events (no-op elsewhere). Returns an unsubscribe. */
export function onOnline(fn: () => void): () => void {
  if (typeof g.addEventListener !== 'function' || typeof g.removeEventListener !== 'function') return () => undefined;
  g.addEventListener('online', fn);
  return () => g.removeEventListener?.('online', fn);
}
