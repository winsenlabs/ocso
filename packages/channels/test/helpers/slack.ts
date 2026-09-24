import { createHmac } from 'node:crypto';
import type { ChannelRuntimeConfig, OutboundTarget, RawHttpRequest } from '../../src/index.js';

export const SIGNING_SECRET = '8f742231b10e8888abcd99yyyzzz85a5';
export const BOT_TOKEN = 'xoxb-fake-test-token-04';
export const TEAM = 'T0001ABCD';
export const BOT_USER = 'U0BOT0001';
export const USER = 'U0CUST001';
export const DM = 'D0DM00001';
export const CHANNEL = 'C0SUPPORT';
export const PUBLIC_KEY = 'sl2w3e4r5t6y7u8i9o0p1a2s';
export const WEBHOOK_URL = `https://ocso.example.com/channels/slack/${PUBLIC_KEY}/webhook`;
export const API = 'https://slack.com/api';
export const NOW = new Date('2026-09-24T10:00:00Z');
export const NOW_SECONDS = String(Math.floor(NOW.getTime() / 1000));

export function slConfig(settings: Record<string, unknown> = {}, secrets: Record<string, string> = {}, webhookUrl: string | null = WEBHOOK_URL): ChannelRuntimeConfig {
  return {
    id: 'chn_slack_main',
    kind: 'SLACK',
    name: 'Meridian Slack',
    settings: { ...settings },
    secrets: { botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET, ...secrets },
    ...(webhookUrl ? { webhookUrl } : {}),
  };
}

/** Reference signature written from Slack's docs, independently of the adapter. */
export function slackSign(body: string, timestamp = NOW_SECONDS, secret = SIGNING_SECRET): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

export function slackRequest(body: string, options: { timestamp?: string; signature?: string | null; method?: 'GET' | 'POST'; contentType?: string } = {}): RawHttpRequest {
  const timestamp = options.timestamp ?? NOW_SECONDS;
  const signature = options.signature === undefined ? slackSign(body, timestamp) : options.signature;
  const headers: Record<string, string> = { 'content-type': options.contentType ?? 'application/json', 'x-slack-request-timestamp': timestamp };
  if (signature !== null) headers['x-slack-signature'] = signature;
  return { method: options.method ?? 'POST', url: WEBHOOK_URL, headers, query: {}, rawBody: Buffer.from(body, 'utf8') } as RawHttpRequest;
}

export function eventCallback(event: Record<string, unknown>, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    token: 'deprecated-verification-token',
    team_id: TEAM,
    api_app_id: 'A0APP0001',
    type: 'event_callback',
    event_id: 'Ev0EVENT001',
    event_time: 1790244000,
    authorizations: [{ enterprise_id: null, team_id: TEAM, user_id: BOT_USER, is_bot: true }],
    event,
    ...overrides,
  });
}

export const dmEvent = (overrides: Record<string, unknown> = {}) => ({
  type: 'message',
  channel_type: 'im',
  channel: DM,
  user: USER,
  team: TEAM,
  text: 'Where is my card?',
  ts: '1790244000.000100',
  event_ts: '1790244000.000100',
  ...overrides,
});

export const mentionEvent = (overrides: Record<string, unknown> = {}) => ({
  type: 'app_mention',
  channel: CHANNEL,
  user: USER,
  team: TEAM,
  text: `<@${BOT_USER}> can you help with &lt;refunds&gt;?`,
  ts: '1790244000.000200',
  event_ts: '1790244000.000200',
  ...overrides,
});

/** Interactivity posts `payload=<json>` form-encoded. */
export function blockActionsBody(action: Record<string, unknown>, overrides: Record<string, unknown> = {}): string {
  const payload = {
    type: 'block_actions',
    team: { id: TEAM, domain: 'meridian' },
    user: { id: USER, username: 'asha', name: 'asha', team_id: TEAM },
    api_app_id: 'A0APP0001',
    container: { type: 'message', message_ts: '1790244100.000300', channel_id: DM, is_ephemeral: false },
    channel: { id: DM, name: 'directmessage' },
    message: { type: 'message', ts: '1790244100.000300', text: 'Which product?' },
    actions: [{ type: 'button', block_id: 'ocso.choices', action_ts: '1790244110.123456', ...action }],
    ...overrides,
  };
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

export function slackTarget(overrides: Partial<OutboundTarget> = {}): OutboundTarget {
  return { identityKind: 'slack_user', identityValue: `${TEAM}:${USER}`, lastInboundAt: NOW, ...overrides };
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
  redirect: RequestInit['redirect'];
}

/** A fake Slack Web API: records calls and answers with `respond`. */
export function slackFetch(respond: (url: string, body: Record<string, unknown>, n: number) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body, redirect: init?.redirect });
    return respond(String(input), body, calls.length);
  };
  return { fetch, calls };
}

export const slackJson = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const posted = (channel = DM, ts = '1790244200.000400'): Response => slackJson({ ok: true, channel, ts, message: { ts } });
export const slackError = (error: string, status = 200, headers: Record<string, string> = {}): Response => slackJson({ ok: false, error }, status, headers);
