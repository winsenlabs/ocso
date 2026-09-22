import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ChannelRuntimeConfig, OutboundMediaResolver, OutboundTarget, RawHttpRequest } from '../../src/index.js';

export const APP_SECRET = 'test-app-secret-9f8e7d6c5b4a3210';
export const VERIFY_TOKEN = 'verify-token-4f9a2c71d3e8b6a0';
export const ACCESS_TOKEN = 'EAAGtestAccessTokenZX9r4Qm2SECRETvalue';
export const PHONE_NUMBER_ID = '106540352242922';
export const WABA_ID = '102290129340398';
export const GRAPH = 'https://graph.facebook.com/v26.0';
export const NOW = new Date('2026-09-22T10:00:00Z');

export function waConfig(
  settings: Record<string, unknown> = {},
  secrets: Record<string, string> = {},
): ChannelRuntimeConfig {
  return {
    id: 'chn_whatsapp_main',
    kind: 'WHATSAPP',
    name: 'Meridian WhatsApp',
    settings: { phoneNumberId: PHONE_NUMBER_ID, ...settings },
    secrets: { accessToken: ACCESS_TOKEN, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, ...secrets },
  };
}

export function fixture(name: string): Buffer {
  return readFileSync(new URL(`../fixtures/whatsapp/${name}.json`, import.meta.url));
}

export function sign(body: Buffer | string, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function postRequest(body: Buffer | null, signature?: string | null): RawHttpRequest {
  const header = signature === undefined ? (body ? sign(body) : undefined) : (signature ?? undefined);
  return { method: 'POST', headers: { 'x-hub-signature-256': header }, query: {}, rawBody: body };
}

export function getRequest(query: Record<string, string>): RawHttpRequest {
  return { method: 'GET', headers: {}, query, rawBody: null };
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
  redirect: RequestInit['redirect'];
}

type Handler = (url: string, call: RecordedCall) => Response | Promise<Response>;

/** Injected fetch: records calls, answers via `handler`. Never touches the network. */
export function fakeFetch(handler: Handler): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    const rawBody = init?.body;
    const body = typeof rawBody === 'string' ? (JSON.parse(rawBody) as unknown) : rawBody;
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body,
      redirect: init?.redirect,
    };
    calls.push(call);
    return handler(url, call);
  };
  return { fetch: impl as typeof fetch, calls };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function graphError(status: number, code: number, message = 'error', details?: string): Response {
  return json(
    {
      error: {
        message,
        type: 'OAuthException',
        code,
        ...(details ? { error_data: { messaging_product: 'whatsapp', details } } : {}),
        fbtrace_id: 'AbCdEf123',
      },
    },
    status,
  );
}

export function target(overrides: Partial<OutboundTarget> = {}): OutboundTarget {
  return {
    identityKind: 'whatsapp_phone',
    identityValue: '+16505551234',
    lastInboundAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    ...overrides,
  };
}

export const mediaResolver = (overrides: Partial<OutboundMediaResolver> = {}): OutboundMediaResolver => ({
  signedUrl: async (blobKey, ttl) => `https://blobs.ocso.example/${blobKey}?ttl=${ttl}&sig=abc`,
  read: async () => ({ data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), mimeType: 'image/jpeg', filename: 'photo.jpg' }),
  ...overrides,
});

/** A streamed body with no Content-Length header. */
export function streamedBody(totalBytes: number, chunkBytes = 64 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkBytes, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(7));
    },
  });
}
