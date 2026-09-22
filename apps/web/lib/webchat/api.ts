import type { z } from 'zod';
import { HistoryResponse, SendResult, SessionResponse, UploadResult, type OutgoingMessage } from './types';

/**
 * Browser client for the public web chat API. The widget page is served from
 * OCSO's origin and `/public/*` is forwarded to the API (next.config.ts
 * rewrites), so every call is same-origin. The bearer is the visitor token —
 * never a staff session.
 */

export class WebChatApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WebChatApiError';
  }

  /** Network failure or a server-side problem: worth retrying. */
  get retriable(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

/** Extensions for files whose browser-reported type is empty (common for audio/docs on some OSes). */
const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg',
};

export function mimeTypeOf(file: { name: string; type: string }): string {
  const declared = file.type.split(';')[0]?.trim().toLowerCase();
  if (declared) return declared;
  return EXTENSION_TYPES[file.name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

/** Types the API's raw body parser accepts directly; others go as octet-stream + a declared type header. */
const RAW_TYPES = /^(image\/|audio\/|video\/|application\/pdf$)/;

type ErrorBody = { error?: { code?: string; message?: string } } | null;

async function errorFrom(res: Response): Promise<WebChatApiError> {
  const body = (await res.json().catch(() => null)) as ErrorBody;
  return new WebChatApiError(res.status, body?.error?.code ?? `http_${res.status}`, body?.error?.message ?? res.statusText);
}

export class WebChatApi {
  readonly base: string;

  constructor(
    readonly publicKey: string,
    private readonly fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
  ) {
    this.base = `/public/webchat/${encodeURIComponent(publicKey)}`;
  }

  private async call<S extends z.ZodType>(path: string, schema: S, init: RequestInit & { token?: string | null } = {}): Promise<z.infer<S>> {
    const { token, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set('accept', 'application/json');
    if (token) headers.set('authorization', `Bearer ${token}`);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, { ...rest, headers, cache: 'no-store', credentials: 'omit' });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new WebChatApiError(0, 'network', 'Network unavailable');
    }
    if (!res.ok) throw await errorFrom(res);
    const parsed = schema.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) throw new WebChatApiError(502, 'invalid_response', 'Unexpected response from the chat service');
    return parsed.data;
  }

  session(body: { visitorToken?: string | undefined; hostToken?: string | undefined }) {
    return this.call('/session', SessionResponse, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  }

  history(token: string, afterSeq = 0, signal?: AbortSignal) {
    return this.call(`/messages${afterSeq > 0 ? `?afterSeq=${afterSeq}` : ''}`, HistoryResponse, { token, ...(signal ? { signal } : {}) });
  }

  send(token: string, message: OutgoingMessage) {
    return this.call('/messages', SendResult, { method: 'POST', token, body: JSON.stringify(message), headers: { 'content-type': 'application/json' } });
  }

  /** Upload one file (XHR for progress events). */
  upload(token: string, file: File, onProgress?: (ratio: number) => void, signal?: AbortSignal): Promise<z.infer<typeof UploadResult>> {
    const type = mimeTypeOf(file);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${this.base}/attachments`);
      xhr.setRequestHeader('authorization', `Bearer ${token}`);
      xhr.setRequestHeader('accept', 'application/json');
      if (RAW_TYPES.test(type)) xhr.setRequestHeader('content-type', type);
      else {
        xhr.setRequestHeader('content-type', 'application/octet-stream');
        xhr.setRequestHeader('x-ocso-content-type', type);
      }
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.(e.loaded / e.total);
      };
      xhr.onerror = () => reject(new WebChatApiError(0, 'network', 'Network unavailable'));
      xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
      xhr.onload = () => {
        let json: unknown;
        try {
          json = JSON.parse(xhr.responseText);
        } catch {
          json = undefined;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          const error = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
          reject(new WebChatApiError(xhr.status, error?.code ?? `http_${xhr.status}`, error?.message ?? 'Upload failed'));
          return;
        }
        const parsed = UploadResult.safeParse(json);
        if (parsed.success) resolve(parsed.data);
        else reject(new WebChatApiError(502, 'invalid_response', 'Unexpected response from the chat service'));
      };
      signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(file);
    });
  }

  streamUrl(): string {
    return `${this.base}/stream`;
  }
}
