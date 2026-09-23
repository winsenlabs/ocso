import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ChannelRuntimeConfig, RawHttpRequest } from '../../src/index.js';

export const ACCOUNT_SID = 'ACa1b2c3d4e5f60718293a4b5c6d7e8f90';
export const AUTH_TOKEN = '3f9c2b7a1e8d4c6b0a5f9e2d7c1b8a46';
export const API_KEY_SID = 'SK5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b';
export const API_KEY_SECRET = 'kQ7vXp2LmN9rT4wZ8yB1cD6fG3hJ5sAe';
export const SENDER = 'whatsapp:+14155238886';
export const MESSAGING_SERVICE_SID = 'MG0f1e2d3c4b5a69788796a5b4c3d2e1f0';
export const PUBLIC_KEY = 'q2w3e4r5t6y7u8i9o0p1a2s3';
export const WEBHOOK_URL = `https://ocso.example.com/channels/twilio-whatsapp/${PUBLIC_KEY}/webhook`;
export const API = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}`;
export const NOW = new Date('2026-09-22T10:00:00Z');

export function twConfig(settings: Record<string, unknown> = {}, secrets: Record<string, string> = {}, webhookUrl: string | null = WEBHOOK_URL): ChannelRuntimeConfig {
  return {
    id: 'chn_twilio_main',
    kind: 'TWILIO_WHATSAPP',
    name: 'Meridian WhatsApp (Twilio)',
    settings: { accountSid: ACCOUNT_SID, from: SENDER, ...settings },
    secrets: { authToken: AUTH_TOKEN, ...secrets },
    ...(webhookUrl ? { webhookUrl } : {}),
  };
}

/** A recorded-shape Twilio webhook (form parameters as Twilio posts them). */
export function twFixture(name: string, overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const params = JSON.parse(readFileSync(new URL(`../fixtures/twilio-whatsapp/${name}.json`, import.meta.url), 'utf8')) as Record<string, string>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete params[key];
    else params[key] = value;
  }
  return params;
}

/** application/x-www-form-urlencoded, as Twilio sends it (spaces as `+`). */
export function formBody(params: Record<string, string> | ReadonlyArray<readonly [string, string]>): Buffer {
  const entries = Array.isArray(params) ? params : Object.entries(params);
  return Buffer.from(new URLSearchParams(entries as Array<[string, string]>).toString(), 'utf8');
}

/**
 * Reference signature, written independently of the adapter from Twilio's
 * spec (twilio-node getExpectedTwilioSignature): url + sorted name+value.
 */
export function twilioSign(url: string, params: Record<string, string>, token = AUTH_TOKEN): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
}

export function webhookRequest(
  params: Record<string, string>,
  options: { url?: string | undefined; signature?: string | null; signedUrl?: string; body?: Buffer } = {},
): RawHttpRequest {
  const url = 'url' in options ? options.url : WEBHOOK_URL;
  const signature = options.signature === undefined ? twilioSign(options.signedUrl ?? WEBHOOK_URL, params) : options.signature;
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature ?? undefined },
    query: {},
    rawBody: options.body ?? formBody(params),
    ...(url ? { url } : {}),
  };
}

export function twilioJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function twilioError(status: number, code: number, message = 'error'): Response {
  return twilioJson({ code, message, more_info: `https://www.twilio.com/docs/errors/${code}`, status }, status);
}

export const messageCreated = (sid = 'SMf0e1d2c3b4a5968778695a4b3c2d1e0f') =>
  twilioJson({ sid, status: 'queued', account_sid: ACCOUNT_SID, to: 'whatsapp:+919812341208', from: SENDER, error_code: null, error_message: null }, 201);

export interface TwilioCall {
  url: string;
  method: string;
  headers: Headers;
  /** Decoded form body (POST), else null. */
  form: URLSearchParams | null;
  redirect: RequestInit['redirect'];
}

/** Injected fetch for the Twilio adapter: records calls, answers via `handler`. Never touches the network. */
export function twilioFetch(handler: (url: string, call: TwilioCall) => Response | Promise<Response>): { fetch: typeof fetch; calls: TwilioCall[] } {
  const calls: TwilioCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    const call: TwilioCall = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      form: typeof init?.body === 'string' ? new URLSearchParams(init.body) : null,
      redirect: init?.redirect,
    };
    calls.push(call);
    return handler(url, call);
  };
  return { fetch: impl as typeof fetch, calls };
}

export const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
