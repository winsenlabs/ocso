import { createHmac } from 'node:crypto';
import type { ChannelRuntimeConfig, RawHttpRequest } from '../../src/index.js';

export const VISITOR_SECRET = 'visitor-secret-0123456789abcdef-0123456789';
export const HOST_SECRET = 'host-app-secret-fedcba9876543210-fedcba98';
export const CHANNEL_ID = 'chn_webchat_site';
export const NOW = new Date('2026-09-22T10:00:00Z');

export function wcConfig(settings: Record<string, unknown> = {}, secrets: Record<string, string> = {}): ChannelRuntimeConfig {
  return {
    id: CHANNEL_ID,
    kind: 'WEBCHAT',
    name: 'Website chat',
    settings,
    secrets: { visitorTokenSecret: VISITOR_SECRET, hostJwtSecret: HOST_SECRET, ...secrets },
  };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Minimal HS256 signer standing in for the embedding host application. */
export function hostJwt(claims: Record<string, unknown>, options: { secret?: string; alg?: string } = {}): string {
  const head = b64({ alg: options.alg ?? 'HS256', typ: 'JWT' });
  const body = b64(claims);
  const signature = createHmac('sha256', options.secret ?? HOST_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

export const unix = (date: Date, offsetSeconds = 0): number => Math.floor(date.getTime() / 1000) + offsetSeconds;

export function widgetRequest(token: string | null, body?: unknown): RawHttpRequest {
  return {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' } : {},
    query: {},
    rawBody: body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}
