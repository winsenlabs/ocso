import { describe, expect, it } from 'vitest';
import { createMsTeamsAdapter, resolveTeamsConfig, TeamsTokenClient, teamsMessageId, type RenderedOutbound } from '../src/index.js';
import { mediaResolver } from './helpers/whatsapp.js';
import {
  activity,
  APP_ID,
  APP_PASSWORD,
  BOT_ID,
  BYSTANDER_AAD,
  CHANNEL_CONVERSATION,
  json,
  mentionActivity,
  microsoftFetch,
  mtConfig,
  NOW,
  PERSONAL_CONVERSATION,
  signingKey,
  teamsRequest,
  teamsTarget,
  TENANT,
  TOKEN_URL,
  USER_AAD,
  type Responder,
} from './helpers/teams.js';

function setup(options: Parameters<typeof microsoftFetch>[0] = {}, now = () => NOW) {
  const ms = microsoftFetch(options);
  const sleeps: number[] = [];
  const adapter = createMsTeamsAdapter({ fetch: ms.fetch, now, sleep: async (ms) => void sleeps.push(ms) });
  return { adapter, ms, sleeps };
}

const text = (value = 'Your card is **on its way**.'): RenderedOutbound => ({ kind: 'MS_TEAMS', payload: { type: 'text', text: value }, partIndexes: [0] });
const card: RenderedOutbound = {
  kind: 'MS_TEAMS',
  payload: {
    type: 'card',
    summary: 'Which product?',
    card: {
      type: 'AdaptiveCard',
      version: '1.4',
      body: [{ type: 'TextBlock', text: 'Which product?', wrap: true }],
      actions: [
        { type: 'Action.Submit', title: 'Cards', data: { ocso: 'choice', id: 'cards', label: 'Cards' } },
        { type: 'Action.OpenUrl', title: 'Help', url: 'https://help.example' },
      ],
    },
  },
  partIndexes: [0],
};
const PERSONAL_POST = `https://smba.trafficmanager.net/amer/v3/conversations/${encodeURIComponent(PERSONAL_CONVERSATION)}/activities`;

describe('Teams send — where replies go', () => {
  it('gets a client-credentials token, then posts a new message in the recorded conversation', async () => {
    const { adapter, ms } = setup();
    const result = await adapter.send(teamsTarget(), text(), mtConfig(), mediaResolver());
    expect(result).toEqual({ ok: true, externalMessageId: teamsMessageId(PERSONAL_CONVERSATION, '1790244100002') });
    const [token, post] = ms.calls;
    expect(token).toMatchObject({ url: TOKEN_URL, method: 'POST', redirect: 'error' });
    expect(Object.fromEntries(new URLSearchParams(token!.body))).toEqual({ grant_type: 'client_credentials', client_id: APP_ID, client_secret: APP_PASSWORD, scope: 'https://api.botframework.com/.default' });
    expect(post).toMatchObject({ url: PERSONAL_POST, method: 'POST', redirect: 'error' });
    expect(post!.headers.get('authorization')).toBe('Bearer bot-connector-token-1');
    expect(JSON.parse(post!.body)).toEqual({
      type: 'message',
      conversation: { id: PERSONAL_CONVERSATION },
      from: { id: BOT_ID },
      textFormat: 'markdown',
      text: 'Your card is **on its way**.',
    });
  });

  it('replies in a channel thread (conversation id carries ;messageid=)', async () => {
    const { adapter, ms } = setup();
    const target = teamsTarget({ replyContext: { serviceUrl: 'https://smba.trafficmanager.net/emea/', conversationId: CHANNEL_CONVERSATION, conversationType: 'channel', tenantId: TENANT, botId: BOT_ID } });
    await adapter.send(target, text(), mtConfig(), mediaResolver());
    expect(ms.connectorCalls()[0]?.url).toBe(`https://smba.trafficmanager.net/emea/v3/conversations/${encodeURIComponent(CHANNEL_CONVERSATION)}/activities`);
    expect(JSON.parse(ms.connectorCalls()[0]!.body)).not.toHaveProperty('replyToId');
  });

  it('ignores an activity id in an older stored reference and posts to the conversation', async () => {
    const { adapter, ms } = setup();
    await adapter.send(teamsTarget({ replyContext: { serviceUrl: 'https://smba.trafficmanager.net/amer', conversationId: PERSONAL_CONVERSATION, activityId: '1790244000456' } }), text(), mtConfig(), mediaResolver());
    expect(ms.connectorCalls()[0]?.url).toBe(`https://smba.trafficmanager.net/amer/v3/conversations/${encodeURIComponent(PERSONAL_CONVERSATION)}/activities`);
    expect(JSON.parse(ms.connectorCalls()[0]!.body)).not.toHaveProperty('replyToId');
  });

  it('sends with no reply context only to the person’s own personal chat, never to a group chat or channel', async () => {
    const { adapter, ms } = setup();
    const config = mtConfig();
    const direct = teamsTarget({ replyContext: undefined });
    // Only a channel @mention seen so far: OCSO knows no private chat with this person.
    adapter.parseInbound(teamsRequest(mentionActivity(), 'verified'), config);
    expect(await adapter.send(direct, text('Link your account: https://ocso.example.com/link/secret'), config, mediaResolver())).toMatchObject({ ok: false, errorCode: 'recipient_undeliverable', retriable: false });
    expect(ms.calls).toEqual([]);

    // After a personal chat message, a context-free send goes to that 1:1 chat as a new message.
    adapter.parseInbound(teamsRequest(activity(), 'verified'), config);
    adapter.parseInbound(teamsRequest(mentionActivity({ id: '1790244000999' }), 'verified'), config);
    expect(await adapter.send(direct, text('Link your account: https://ocso.example.com/link/secret'), config, mediaResolver())).toMatchObject({ ok: true });
    const [post] = ms.connectorCalls();
    expect(post?.url).toBe(PERSONAL_POST);
    expect(JSON.parse(post!.body)).toMatchObject({ conversation: { id: PERSONAL_CONVERSATION } });
    expect(JSON.parse(post!.body)).not.toHaveProperty('replyToId');

    // Per channel and per person: another channel, or another person, has no personal chat yet.
    const other = mtConfig();
    Object.assign(other, { id: '0199aaaa-0000-7000-8000-000000000999' });
    expect(await adapter.send(direct, text(), other, mediaResolver())).toMatchObject({ ok: false, errorCode: 'recipient_undeliverable' });
    expect(await adapter.send(teamsTarget({ replyContext: undefined, identityValue: `${TENANT}:${BYSTANDER_AAD}` }), text(), config, mediaResolver())).toMatchObject({ ok: false, errorCode: 'recipient_undeliverable' });
  });

  it('forgets a personal chat after a day', async () => {
    let now = NOW.getTime();
    const ms = microsoftFetch();
    const adapter = createMsTeamsAdapter({ fetch: ms.fetch, now: () => new Date(now), sleep: async () => undefined });
    const config = mtConfig();
    adapter.parseInbound(teamsRequest(activity(), 'verified'), config);
    now += 25 * 3_600_000;
    expect(await adapter.send(teamsTarget({ replyContext: undefined }), text(), config, mediaResolver())).toMatchObject({ ok: false, errorCode: 'recipient_undeliverable' });
  });

  it('sends a choice card as an Adaptive Card attachment addressed to the customer asked', async () => {
    const { adapter, ms } = setup();
    await adapter.send(teamsTarget(), card, mtConfig(), mediaResolver());
    const body = JSON.parse(ms.connectorCalls()[0]!.body) as { summary: string; attachments: Array<{ contentType: string; content: { actions: unknown[] } }> };
    expect(body.summary).toBe('Which product?');
    expect(body.attachments[0]?.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(body.attachments[0]?.content.actions).toEqual([
      { type: 'Action.Submit', title: 'Cards', data: { ocso: 'choice', id: 'cards', label: 'Cards', for: USER_AAD } },
      { type: 'Action.OpenUrl', title: 'Help', url: 'https://help.example' },
    ]);
  });

  it('never sends the token to a service URL outside the Bot Connector hosts (SSRF guard)', async () => {
    for (const serviceUrl of ['https://attacker.example.com/', 'https://ocso-exfil.trafficmanager.net/', 'http://smba.trafficmanager.net/amer/', 'https://smba.trafficmanager.net.evil.com/', 'https://user:pw@smba.trafficmanager.net/', 'https://smba.trafficmanager.net:8443/']) {
      const { adapter, ms } = setup();
      const result = await adapter.send(teamsTarget({ replyContext: { serviceUrl, conversationId: PERSONAL_CONVERSATION } }), text(), mtConfig(), mediaResolver());
      expect(result).toMatchObject({ ok: false, errorCode: 'invalid_recipient', retriable: false });
      expect(ms.calls).toEqual([]);
    }
  });

  it('accepts a configured extra host (a local stub) and the US Government cloud hosts only when configured', async () => {
    const stub = setup();
    const local = teamsTarget({ replyContext: { serviceUrl: 'http://127.0.0.1:3978/', conversationId: PERSONAL_CONVERSATION } });
    expect(await stub.adapter.send(local, text(), mtConfig(), mediaResolver())).toMatchObject({ ok: false, errorCode: 'invalid_recipient' });
    expect(await stub.adapter.send(local, text(), mtConfig({ endpoints: { serviceUrlHosts: ['127.0.0.1'] } }), mediaResolver())).toMatchObject({ ok: true });
    const gov = teamsTarget({ replyContext: { serviceUrl: 'https://smba.infra.gcc.teams.microsoft.com/teams', conversationId: PERSONAL_CONVERSATION } });
    expect(await setup().adapter.send(gov, text(), mtConfig(), mediaResolver())).toMatchObject({ ok: false, errorCode: 'invalid_recipient' });
    const govSetup = setup();
    expect(await govSetup.adapter.send(gov, text(), mtConfig({ cloud: 'usgov' }), mediaResolver())).toMatchObject({ ok: true });
    expect(govSetup.ms.tokenCalls()[0]?.url).toBe(`https://login.microsoftonline.us/${TENANT}/oauth2/v2.0/token`);
  });

  it('fails without retrying when there is no conversation to reply in, and refuses other kinds, payloads and tenants', async () => {
    const { adapter, ms } = setup();
    expect(await adapter.send(teamsTarget({ replyContext: undefined }), text(), mtConfig(), mediaResolver())).toMatchObject({ ok: false, errorCode: 'recipient_undeliverable', retriable: false });
    expect(await adapter.send(teamsTarget({ identityKind: 'slack_user', identityValue: 'T:U' }), text(), mtConfig(), mediaResolver())).toMatchObject({ ok: false, errorCode: 'invalid_recipient' });
    expect(await adapter.send(teamsTarget(), { kind: 'SLACK', payload: { type: 'text', text: 'x' }, partIndexes: [0] }, mtConfig(), mediaResolver())).toMatchObject({ ok: false, errorCode: 'invalid_payload' });
    const foreign = teamsTarget({ replyContext: { serviceUrl: 'https://smba.trafficmanager.net/amer/', conversationId: PERSONAL_CONVERSATION, tenantId: '11111111-2222-4333-8444-555555555555' } });
    expect(await adapter.send(foreign, text(), mtConfig(), mediaResolver())).toMatchObject({ ok: false, errorCode: 'invalid_recipient' });
    expect(await adapter.send(teamsTarget(), text(), mtConfig({ appId: 'bad' }), mediaResolver())).toMatchObject({ ok: false, errorCode: 'invalid_channel_config' });
    expect(ms.calls).toEqual([]);
  });
});

describe('Teams send — tokens', () => {
  it('caches the token across sends until shortly before it expires', async () => {
    let now = NOW.getTime();
    const { adapter, ms } = setup({}, () => new Date(now));
    const config = mtConfig();
    await adapter.send(teamsTarget(), text(), config, mediaResolver());
    await adapter.send(teamsTarget(), text(), mtConfig(), mediaResolver());
    expect(ms.tokenCalls()).toHaveLength(1);
    now += 3599_000 - 4 * 60_000;
    await adapter.send(teamsTarget(), text(), config, mediaResolver());
    expect(ms.tokenCalls()).toHaveLength(2);
    expect(ms.connectorCalls().at(-1)?.headers.get('authorization')).toBe('Bearer bot-connector-token-2');
  });

  it('uses a separate token per app credentials (a rotated secret is a new token)', async () => {
    const { adapter, ms } = setup();
    await adapter.send(teamsTarget(), text(), mtConfig(), mediaResolver());
    await adapter.send(teamsTarget(), text(), mtConfig({}, { appPassword: 'rotated.secret.value.0002' }), mediaResolver());
    expect(ms.tokenCalls()).toHaveLength(2);
  });

  it('shares one token request between concurrent sends', async () => {
    const { adapter, ms } = setup();
    await Promise.all([1, 2, 3].map(() => adapter.send(teamsTarget(), text(), mtConfig(), mediaResolver())));
    expect(ms.tokenCalls()).toHaveLength(1);
  });

  it('uses the botframework.com authority for a multi-tenant bot', async () => {
    const { adapter, ms } = setup();
    await adapter.send(teamsTarget(), text(), mtConfig({ appType: 'MultiTenant', tenantId: undefined }), mediaResolver());
    expect(ms.tokenCalls()[0]?.url).toBe('https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token');
  });

  it('reports refused credentials without retrying and never echoes the secret', async () => {
    const refuse: Responder = () => json({ error: 'invalid_client', error_description: `AADSTS7000215: Invalid client secret provided (${APP_PASSWORD}).\r\nTrace ID: x` }, 401);
    const { adapter, ms } = setup({ token: refuse });
    const result = await adapter.send(teamsTarget(), text(), mtConfig(), mediaResolver());
    expect(result).toMatchObject({ ok: false, errorCode: 'auth_failed', retriable: false });
    expect(JSON.stringify(result)).toContain('AADSTS7000215');
    expect(JSON.stringify(result)).not.toContain(APP_PASSWORD);
    expect(ms.connectorCalls()).toEqual([]);
  });

  it('retries later (outbox) when Entra is down, rate-limits or answers without a token', async () => {
    for (const [respond, code] of [
      [() => json({}, 503), 'provider_unavailable'],
      [() => json({}, 429), 'rate_limited'],
      [() => json({ token_type: 'Bearer' }), 'provider_unavailable'],
      [() => Promise.reject(new Error('socket hang up')), 'network_error'],
    ] as Array<[Responder, string]>) {
      const { adapter } = setup({ token: respond });
      expect(await adapter.send(teamsTarget(), text(), mtConfig(), mediaResolver())).toMatchObject({ ok: false, errorCode: code, retriable: true });
    }
  });

  it('TeamsTokenClient returns the cached token and requests a fresh one on demand', async () => {
    const ms = microsoftFetch();
    const client = new TeamsTokenClient(ms.fetch, () => NOW.getTime());
    const config = resolveTeamsConfig(mtConfig());
    expect(await client.token(config)).toMatchObject({ ok: true, token: 'bot-connector-token-1', expiresAt: NOW.getTime() + 3599_000 });
    expect(await client.token(config)).toMatchObject({ token: 'bot-connector-token-1' });
    expect(await client.token(config, { fresh: true })).toMatchObject({ token: 'bot-connector-token-2' });
  });
});

describe('Teams send — Bot Connector errors and retries', () => {
  it('retries 429 in place after Retry-After, then succeeds', async () => {
    let posts = 0;
    const { adapter, sleeps, ms } = setup({ connector: () => (++posts === 1 ? json({ error: { code: 'TooManyRequests' } }, 429, { 'retry-after': '3' }) : undefined) });
    expect(await adapter.send(teamsTarget(), text(), mtConfig(), mediaResolver())).toMatchObject({ ok: true });
    expect(sleeps).toEqual([3000]);
    expect(ms.connectorCalls()).toHaveLength(2);
  });

  it('retries 5xx with backoff (1 s, 2 s) up to `retries`, then hands the retry to the outbox', async () => {
    const { adapter, sleeps, ms } = setup({ connector: () => json({ error: { code: 'ServiceError', message: 'boom' } }, 502) });
    expect(await adapter.send(teamsTarget(), text(), mtConfig(), mediaResolver())).toMatchObject({ ok: false, errorCode: 'provider_unavailable', retriable: true, message: expect.stringContaining('ServiceError') });
    expect(sleeps).toEqual([1000, 2000]);
    expect(ms.connectorCalls()).toHaveLength(3);
  });

  it('hands a long Retry-After straight to the outbox', async () => {
    const { adapter, sleeps } = setup({ connector: () => json({}, 429, { 'retry-after': '120' }) });
    expect(await adapter.send(teamsTarget(), text(), mtConfig(), mediaResolver())).toMatchObject({ ok: false, errorCode: 'rate_limited', retriable: true, message: expect.stringContaining('retry after 120s') });
    expect(sleeps).toEqual([]);
  });

  it('refreshes the token once after a 401 from the connector', async () => {
    let posts = 0;
    const { adapter, ms } = setup({ connector: () => (++posts === 1 ? json({ error: { code: 'Unauthorized' } }, 401) : undefined) });
    expect(await adapter.send(teamsTarget(), text(), mtConfig(), mediaResolver())).toMatchObject({ ok: true });
    expect(ms.tokenCalls()).toHaveLength(2);
    expect(ms.connectorCalls().map((c) => c.headers.get('authorization'))).toEqual(['Bearer bot-connector-token-1', 'Bearer bot-connector-token-2']);
  });

  it('gives up on a persistent 401 without retrying later', async () => {
    const { adapter, ms } = setup({ connector: () => json({}, 401) });
    expect(await adapter.send(teamsTarget(), text(), mtConfig(), mediaResolver())).toMatchObject({ ok: false, errorCode: 'auth_failed', retriable: false });
    expect(ms.connectorCalls()).toHaveLength(2);
  });

  it.each([
    [403, 'BotNotInConversationRoster', 'recipient_undeliverable'],
    [404, 'ConversationNotFound', 'recipient_undeliverable'],
    [403, 'Forbidden', 'permission_denied'],
    [400, 'BadArgument', 'invalid_request'],
    [413, 'MessageSizeTooBig', 'invalid_request'],
    [409, 'Conflict', 'provider_rejected'],
  ])('maps HTTP %i %s to %s without retrying', async (status, code, errorCode) => {
    const { adapter, sleeps } = setup({ connector: () => json({ error: { code, message: 'details' } }, status) });
    expect(await adapter.send(teamsTarget(), text(), mtConfig(), mediaResolver())).toMatchObject({ ok: false, errorCode, retriable: false });
    expect(sleeps).toEqual([]);
  });

  it('treats a network failure as retriable and ambiguous (not retried in place)', async () => {
    const { adapter, ms } = setup({ connector: () => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })) });
    expect(await adapter.send(teamsTarget(), text(), mtConfig(), mediaResolver())).toMatchObject({ ok: false, errorCode: 'timeout', retriable: true });
    expect(ms.connectorCalls()).toHaveLength(1);
  });
});

describe('Teams connection check', () => {
  it('requests a fresh token, fetches the signing keys and checks the messaging endpoint; never posts a message', async () => {
    const key = await signingKey();
    const { adapter, ms } = setup({ keys: [key.jwk] });
    const result = await adapter.checkConnection(mtConfig());
    expect(result).toEqual({
      ok: true,
      checks: [
        { name: 'App credentials', ok: true, detail: `Microsoft Entra issued a Bot Connector token for app ${APP_ID} (tenant ${TENANT})` },
        { name: 'Signing keys', ok: true, detail: '1 Bot Framework signing key published; inbound messages can be verified' },
        { name: 'Messaging endpoint', ok: true, detail: expect.stringContaining('https webhook') },
      ],
    });
    expect(ms.connectorCalls()).toEqual([]);
  });

  it('reports a wrong secret, unreachable keys and an http endpoint without leaking the secret', async () => {
    const { adapter } = setup({
      token: () => json({ error: 'invalid_client', error_description: `AADSTS7000215: Invalid client secret ${APP_PASSWORD}` }, 401),
      metadata: () => json({}, 500),
    });
    const result = await adapter.checkConnection(mtConfig({}, {}, 'http://localhost:4000/channels/ms-teams/k/webhook'));
    expect(result.ok).toBe(false);
    expect(result.checks.map((c) => [c.name, c.ok])).toEqual([
      ['App credentials', false],
      ['Signing keys', false],
      ['Messaging endpoint', false],
    ]);
    expect(JSON.stringify(result)).not.toContain(APP_PASSWORD);
  });

  it('reports an invalid configuration as one failed check', async () => {
    const { adapter, ms } = setup();
    expect(await adapter.checkConnection(mtConfig({ appType: 'SingleTenant', tenantId: undefined }))).toEqual({ ok: false, checks: [{ name: 'Configuration', ok: false, detail: expect.stringContaining('tenantId') }] });
    expect(ms.calls).toEqual([]);
  });
});
