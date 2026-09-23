import type { AbortSignalLike } from './platform.js';
import type { AttachmentInput, ChatContext, CsatResult, FetchLike, NativeFile, ResponseLike, WebChatConfig } from './types.js';
import { parseConfig, parseHistory, parseSendResult, parseSession, parseUpload, WireError, type OutgoingMessage, type WireHistory, type WireSendResult, type WireSession, type WireUpload } from './wire.js';

/**
 * HTTP client for OCSO's public web chat API. Every call is a plain bearer
 * request (`credentials: 'omit'`): the bearer is the visitor token, never a
 * cookie, so the API can allow the host origin by CORS without credentials.
 */

export class ChatApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** From `Retry-After` on 429/503. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ChatApiError';
  }

  /** Network failure, rate limit or a server-side problem: worth retrying. */
  get retriable(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

/** Body of POST /session. */
export interface SessionBody {
  visitorToken?: string;
  sessionPass?: string;
  userToken?: string;
  context?: ChatContext;
}

/** Extensions for files whose reported type is empty (common for audio/docs on some OSes). */
const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg',
};

export function mimeTypeOf(file: { name?: string | undefined; type?: string | undefined }): string {
  const declared = (file.type ?? '').split(';')[0]?.trim().toLowerCase();
  if (declared) return declared;
  const ext = (file.name ?? '').split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_TYPES[ext] ?? 'application/octet-stream';
}

/** Types the API's raw body parser accepts directly; others go as octet-stream + a declared type header. */
const RAW_TYPES = /^(image\/|audio\/|video\/|application\/pdf$)/;

export const isNativeFile = (file: AttachmentInput): file is NativeFile => typeof (file as NativeFile).uri === 'string';

export function fileName(file: AttachmentInput): string {
  return (isNativeFile(file) ? file.name : file.name) || 'attachment';
}

function retryAfter(res: ResponseLike): number | null {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export async function errorFrom(res: ResponseLike): Promise<ChatApiError> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  return new ChatApiError(res.status, body?.error?.code ?? `http_${res.status}`, body?.error?.message ?? res.statusText ?? 'Request failed', retryAfter(res));
}

interface CallInit {
  method?: 'GET' | 'POST';
  token?: string | null;
  json?: unknown;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignalLike | undefined;
}

export class ChatApi {
  readonly base: string;

  constructor(
    baseUrl: string,
    readonly publishableKey: string,
    private readonly fetchImpl: FetchLike,
  ) {
    this.base = `${baseUrl.replace(/\/+$/, '')}/public/webchat/${encodeURIComponent(publishableKey)}`;
  }

  /** Raw request; network failures become `ChatApiError(0, 'network')`. */
  async request(path: string, init: CallInit = {}): Promise<ResponseLike> {
    const headers: Record<string, string> = { accept: 'application/json', ...init.headers };
    if (init.token) headers['authorization'] = `Bearer ${init.token}`;
    let body = init.body;
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.json);
    }
    try {
      return await this.fetchImpl(`${this.base}${path}`, {
        method: init.method ?? 'GET',
        headers,
        ...(body !== undefined ? { body } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      throw new ChatApiError(0, 'network', 'Network unavailable');
    }
  }

  private async call<T>(path: string, parse: (v: unknown) => T, init: CallInit = {}): Promise<T> {
    const res = await this.request(path, init);
    if (!res.ok) throw await errorFrom(res);
    try {
      return parse(await res.json().catch(() => undefined));
    } catch (err) {
      if (err instanceof WireError) throw new ChatApiError(502, 'invalid_response', err.message);
      throw err;
    }
  }

  config(signal?: AbortSignalLike): Promise<WebChatConfig> {
    return this.call('/config', parseConfig, { signal });
  }

  session(body: SessionBody): Promise<WireSession> {
    return this.call('/session', parseSession, { method: 'POST', json: body });
  }

  history(token: string, afterSeq = 0, signal?: AbortSignalLike): Promise<WireHistory> {
    return this.call(`/messages${afterSeq > 0 ? `?afterSeq=${afterSeq}` : ''}`, parseHistory, { token, signal });
  }

  send(token: string, message: OutgoingMessage): Promise<WireSendResult> {
    return this.call('/messages', parseSendResult, { method: 'POST', token, json: message });
  }

  async upload(token: string, file: AttachmentInput, signal?: AbortSignalLike): Promise<WireUpload> {
    const type = mimeTypeOf({ name: fileName(file), type: file.type });
    const body = isNativeFile(file) ? await this.readNative(file) : file;
    const headers: Record<string, string> = RAW_TYPES.test(type) ? { 'content-type': type } : { 'content-type': 'application/octet-stream', 'x-ocso-content-type': type };
    return this.call('/attachments', parseUpload, { method: 'POST', token, body, headers, signal });
  }

  /** React Native: read a local `{ uri }` into a Blob (fetch of a file:// or content:// uri). */
  private async readNative(file: NativeFile): Promise<unknown> {
    const res = await this.fetchImpl(file.uri);
    if (!res.blob) throw new ChatApiError(0, 'attachment_unreadable', 'Could not read the file');
    return res.blob();
  }

  csat(token: string, score: number, comment?: string): Promise<CsatResult> {
    return this.call('/csat', (v) => {
      const o = (v ?? {}) as Partial<CsatResult>;
      return { recorded: o.recorded === true, score: typeof o.score === 'number' ? o.score : score, receivedAt: typeof o.receivedAt === 'string' ? o.receivedAt : new Date().toISOString() };
    }, { method: 'POST', token, json: comment ? { score, comment } : { score } });
  }

  /** Open the SSE stream (the caller reads the body). */
  stream(token: string, signal: AbortSignalLike): Promise<ResponseLike> {
    return this.request('/stream', { token, signal, headers: { accept: 'text/event-stream' } });
  }
}
