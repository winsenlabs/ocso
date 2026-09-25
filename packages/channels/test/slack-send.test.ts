import { describe, expect, it } from 'vitest';
import { createSlackChannelAdapter, type RenderedOutbound } from '../src/index.js';
import { mediaResolver } from './helpers/whatsapp.js';
import { API, BOT_TOKEN, CHANNEL, DM, NOW, posted, slackError, slackFetch, slackJson, slackTarget, slConfig, TEAM, USER } from './helpers/slack.js';

function setup(respond: Parameters<typeof slackFetch>[0] = () => posted()) {
  const { fetch, calls } = slackFetch(respond);
  const sleeps: number[] = [];
  const adapter = createSlackChannelAdapter({ fetch, now: () => NOW, sleep: async (ms) => void sleeps.push(ms) });
  return { adapter, calls, sleeps };
}

const text = (value = 'Your card is on its way.'): RenderedOutbound => ({ kind: 'SLACK', payload: { type: 'text', text: value }, partIndexes: [0] });
const blocks: RenderedOutbound = {
  kind: 'SLACK',
  payload: { type: 'blocks', text: 'Pick', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Pick' } }] },
  partIndexes: [0],
};

describe('Slack send — where replies go', () => {
  it('posts to the recorded thread with the bot token and returns <channel>:<ts>', async () => {
    const { adapter, calls } = setup(() => posted(CHANNEL, '1790244200.000400'));
    const target = slackTarget({ replyContext: { teamId: TEAM, channel: CHANNEL, threadTs: '1790244000.000200' } });
    expect(await adapter.send(target, text(), slConfig(), mediaResolver())).toEqual({ ok: true, externalMessageId: `${CHANNEL}:1790244200.000400` });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `${API}/chat.postMessage`, method: 'POST', redirect: 'error' });
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${BOT_TOKEN}`);
    expect(calls[0]?.body).toEqual({ channel: CHANNEL, text: 'Your card is on its way.', thread_ts: '1790244000.000200', mrkdwn: true, unfurl_links: false, unfurl_media: false });
  });

  it('posts to the recorded DM without a thread', async () => {
    const { adapter, calls } = setup();
    await adapter.send(slackTarget({ replyContext: { teamId: TEAM, channel: DM } }), blocks, slConfig(), mediaResolver());
    expect(calls[0]?.body).toMatchObject({ channel: DM, text: 'Pick', blocks: [{ type: 'section' }] });
    expect(calls[0]?.body).not.toHaveProperty('thread_ts');
  });

  it('addresses choice buttons to the customer asked (block_id ocso.choices:<user id>)', async () => {
    const { adapter, calls } = setup();
    const choices: RenderedOutbound = {
      kind: 'SLACK',
      payload: { type: 'blocks', text: 'Pick', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Pick' } }, { type: 'actions', block_id: 'ocso.choices', elements: [] }, { type: 'actions', block_id: 'x' }] },
      partIndexes: [0],
    };
    await adapter.send(slackTarget({ replyContext: { teamId: TEAM, channel: CHANNEL, threadTs: '1790244000.000200' } }), choices, slConfig(), mediaResolver());
    expect(calls[0]?.body['blocks']).toEqual([{ type: 'section', text: { type: 'mrkdwn', text: 'Pick' } }, { type: 'actions', block_id: `ocso.choices:${USER}`, elements: [] }, { type: 'actions', block_id: 'x' }]);
  });

  it('falls back to the customer’s DM (user id) without a reply context or with a malformed one', async () => {
    for (const replyContext of [undefined, { channel: 'not-a-channel' }]) {
      const { adapter, calls } = setup();
      await adapter.send(slackTarget(replyContext ? { replyContext } : {}), text(), slConfig(), mediaResolver());
      expect(calls[0]?.body).toMatchObject({ channel: USER });
    }
  });

  it('refuses other identity kinds, foreign payloads and an invalid config without calling Slack', async () => {
    const { adapter, calls } = setup();
    expect(await adapter.send(slackTarget({ identityKind: 'whatsapp_phone', identityValue: '+15550001' }), text(), slConfig(), mediaResolver())).toMatchObject({ ok: false, errorCode: 'invalid_recipient' });
    expect(await adapter.send(slackTarget(), { kind: 'WHATSAPP', payload: { type: 'text', body: 'x' }, partIndexes: [0] }, slConfig(), mediaResolver())).toMatchObject({ ok: false, errorCode: 'invalid_payload' });
    expect(await adapter.send(slackTarget(), text(), slConfig({}, { botToken: 'xoxp-user-token-000000' }), mediaResolver())).toMatchObject({ ok: false, errorCode: 'invalid_channel_config', retriable: false });
    expect(calls).toHaveLength(0);
  });
});

describe('Slack send — failures and retries', () => {
  it('retries 429 in place after Retry-After, then succeeds', async () => {
    const { adapter, calls, sleeps } = setup((_url, _body, n) => (n === 1 ? slackError('ratelimited', 429, { 'retry-after': '3' }) : posted()));
    expect(await adapter.send(slackTarget(), text(), slConfig(), mediaResolver())).toMatchObject({ ok: true });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([3000]);
  });

  it('hands a long or repeated 429 back to the outbox as retriable rate_limited', async () => {
    const long = setup(() => slackError('ratelimited', 429, { 'retry-after': '120' }));
    expect(await long.adapter.send(slackTarget(), text(), slConfig(), mediaResolver())).toMatchObject({ ok: false, errorCode: 'rate_limited', retriable: true });
    expect(long.calls).toHaveLength(1);
    const repeated = setup(() => slackError('ratelimited', 429, { 'retry-after': '1' }));
    expect(await repeated.adapter.send(slackTarget(), text(), slConfig({ rateLimitRetries: 2 }), mediaResolver())).toMatchObject({ ok: false, errorCode: 'rate_limited', retriable: true });
    expect(repeated.calls).toHaveLength(3);
    expect(repeated.sleeps).toEqual([1000, 1000]);
  });

  it.each([
    ['invalid_auth', 'auth_failed', false],
    ['token_revoked', 'auth_failed', false],
    ['missing_scope', 'permission_denied', false],
    ['channel_not_found', 'recipient_undeliverable', false],
    ['not_in_channel', 'recipient_undeliverable', false],
    ['msg_too_long', 'invalid_request', false],
    ['internal_error', 'provider_unavailable', true],
    ['something_new', 'provider_rejected', false],
  ])('maps Slack error %s to %s', async (error, errorCode, retriable) => {
    const { adapter } = setup(() => slackError(error));
    expect(await adapter.send(slackTarget(), text(), slConfig(), mediaResolver())).toEqual({ ok: false, errorCode, retriable, message: `Slack error ${error}` });
  });

  it('treats 5xx and network failures as retriable and never leaks the token', async () => {
    const down = setup(() => new Response('upstream down', { status: 503 }));
    expect(await down.adapter.send(slackTarget(), text(), slConfig(), mediaResolver())).toMatchObject({ ok: false, errorCode: 'provider_unavailable', retriable: true });
    const offline = setup(() => Promise.reject(new TypeError('fetch failed')));
    expect(await offline.adapter.send(slackTarget(), text(), slConfig(), mediaResolver())).toMatchObject({ ok: false, errorCode: 'network_error', retriable: true });
    const leaky = setup(() => slackError(`invalid_auth ${BOT_TOKEN}`));
    const result = await leaky.adapter.send(slackTarget(), text(), slConfig(), mediaResolver());
    expect(JSON.stringify(result)).not.toContain(BOT_TOKEN);
  });

  it('does not retry an accepted message without a ts', async () => {
    const { adapter } = setup(() => slackJson({ ok: true }));
    expect(await adapter.send(slackTarget(), text(), slConfig(), mediaResolver())).toMatchObject({ ok: false, errorCode: 'provider_error', retriable: false });
  });
});

describe('Slack connection check', () => {
  const authOk = (scopes = 'app_mentions:read,chat:write,im:history,users:read,users:read.email') =>
    slackJson({ ok: true, team: 'Meridian', team_id: TEAM, user: 'ocso', user_id: 'U0BOT0001', bot_id: 'B0BOT0001' }, 200, { 'x-oauth-scopes': scopes });

  it('passes with a bot token, every scope and an https Request URL, calling auth.test only', async () => {
    const { adapter, calls } = setup(() => authOk());
    const result = await adapter.checkConnection(slConfig());
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual(['Bot token', 'Bot scopes', 'Request URL']);
    expect(result.checks[0]?.detail).toBe('valid for "Meridian" as @ocso');
    expect(calls.map((c) => c.url)).toEqual([`${API}/auth.test`]);
  });

  it('names missing scopes, a rejected token and a non-https Request URL', async () => {
    const scopes = (await setup(() => authOk('chat:write,users:read')).adapter.checkConnection(slConfig())).checks[1];
    // Each missing required scope is named with what breaks, and the check points at the troubleshooting entry.
    expect(scopes).toMatchObject({ ok: false, help: 'missing-scope' });
    expect(scopes?.detail).toContain('im:history (without it direct messages to the app never reach OCSO)');
    expect(scopes?.detail).toContain('app_mentions:read (without it @mentions in channels never reach OCSO)');
    expect(scopes?.detail).toContain('reinstall the app');
    expect(scopes?.detail).not.toContain('users:read.email');
    // Optional scopes (not called yet) are noted, never a failure.
    const optional = (await setup(() => authOk('app_mentions:read,chat:write,im:history')).adapter.checkConnection(slConfig())).checks[1];
    expect(optional).toMatchObject({ ok: true, detail: expect.stringContaining('optional users:read, users:read.email not granted') });
    const rejected = await setup(() => slackError('invalid_auth')).adapter.checkConnection(slConfig());
    expect(rejected).toMatchObject({ ok: false, checks: [{ name: 'Bot token', ok: false, detail: 'Slack rejected the bot token (invalid_auth)', help: 'bot-token-invalid' }, { name: 'Request URL', ok: true }] });
    const http = await setup(() => authOk()).adapter.checkConnection(slConfig({}, {}, 'http://localhost:4000/channels/slack/k/webhook'));
    expect(http.ok).toBe(false);
    expect(http.checks[2]).toMatchObject({ name: 'Request URL', ok: false, help: 'request-url-not-https' });
  });

  it('reports an invalid configuration without calling Slack', async () => {
    const { adapter, calls } = setup();
    expect(await adapter.checkConnection(slConfig({}, { signingSecret: '' }))).toMatchObject({ ok: false, checks: [{ name: 'Configuration', ok: false }] });
    expect(calls).toHaveLength(0);
  });
});
