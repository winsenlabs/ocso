/**
 * Minimal Server-Sent Events parser (WHATWG event-stream format) for a fetch()
 * body: EventSource cannot send an Authorization header. Pure and incremental:
 * feed text chunks as they arrive. Copied from OCSO's own widget
 * (apps/web/lib/webchat/sse.ts) so both clients parse the stream identically.
 */

export interface SseMessage {
  event: string;
  data: string;
  id: string | null;
}

export interface SseParser {
  push(chunk: string): void;
  /** Flush a final event that was not followed by a blank line. */
  end(): void;
}

export function createSseParser(onMessage: (message: SseMessage) => void): SseParser {
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let id: string | null = null;

  const dispatch = () => {
    if (data.length) onMessage({ event: event || 'message', data: data.join('\n'), id });
    event = '';
    data = [];
  };

  const line = (raw: string) => {
    if (raw === '') return dispatch();
    if (raw.startsWith(':')) return;
    const colon = raw.indexOf(':');
    const field = colon === -1 ? raw : raw.slice(0, colon);
    let value = colon === -1 ? '' : raw.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id' && !value.includes('\0')) id = value;
  };

  return {
    push(chunk) {
      buffer += chunk;
      let index: number;
      while ((index = buffer.search(/\r\n|\r|\n/)) !== -1) {
        const newline = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
        // A lone \r at the very end may be the first half of \r\n: wait for more.
        if (buffer[index] === '\r' && index === buffer.length - 1) break;
        line(buffer.slice(0, index));
        buffer = buffer.slice(index + newline);
      }
    },
    end() {
      if (buffer) line(buffer);
      buffer = '';
      dispatch();
    },
  };
}

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** 0..1 share of the delay that is randomized (full jitter at 1). */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1_000, maxMs: 30_000, jitter: 0.3 };

/** Exponential backoff with jitter: attempt 1 → ~base, doubling up to max. */
export function backoffDelay(attempt: number, options: BackoffOptions = DEFAULT_BACKOFF, random: () => number = Math.random): number {
  const exp = Math.min(options.maxMs, options.baseMs * 2 ** Math.max(0, attempt - 1));
  const spread = exp * options.jitter;
  return Math.round(exp - spread + random() * spread);
}

export interface Utf8Decoder {
  decode(chunk: Uint8Array | string): string;
}

interface TextDecoderLike {
  decode(input?: Uint8Array, options?: { stream?: boolean }): string;
}

/**
 * Streaming UTF-8 decoder: the platform `TextDecoder` when there is one,
 * otherwise a small fallback (older React Native runtimes lack TextDecoder).
 */
export function createUtf8Decoder(): Utf8Decoder {
  const Ctor = (globalThis as { TextDecoder?: new (label?: string) => TextDecoderLike }).TextDecoder;
  if (Ctor) {
    const decoder = new Ctor('utf-8');
    return { decode: (chunk) => (typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })) };
  }
  let pending: number[] = [];
  return {
    decode(chunk) {
      if (typeof chunk === 'string') return chunk;
      const bytes = pending.concat(Array.from(chunk));
      let out = '';
      let i = 0;
      while (i < bytes.length) {
        const b = bytes[i] as number;
        const size = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
        if (i + size > bytes.length) break;
        let cp = size === 1 ? b : b & (0xff >> (size + 1));
        for (let k = 1; k < size; k++) cp = (cp << 6) | ((bytes[i + k] as number) & 0x3f);
        out += b >= 0x80 && b < 0xc0 ? '�' : String.fromCodePoint(cp);
        i += size;
      }
      pending = bytes.slice(i);
      return out;
    },
  };
}
