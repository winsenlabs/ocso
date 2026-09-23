import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOcsoChat, memoryStorage, type OcsoChatClient, type OcsoChatOptions } from '../src/index.js';
import { subjectHint } from '../src/session.js';
import { fakeServer, type FakeServer } from './helpers/fake-server.js';

const clients: OcsoChatClient[] = [];

function clientFor(server: FakeServer, extra: Partial<OcsoChatOptions> = {}): OcsoChatClient {
  const client = createOcsoChat({ baseUrl: server.baseUrl, publishableKey: server.publishableKey, fetch: server.fetch, storage: memoryStorage(), transport: 'poll', pollIntervalMs: 50, ...extra });
  clients.push(client);
  return client;
}

/** A JWT-shaped user token the fake server accepts (`good.<claims>.sig`). */
const jwtFor = (sub: string) => `good.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.sig`;
const lastSession = (server: FakeServer) => (server.calls('POST /session').at(-1)?.body ?? {}) as { visitorToken?: string; userToken?: string };

afterEach(() => {
  for (const c of clients.splice(0)) c.disconnect();
});

describe('auth modes', () => {
  it('anonymous: sends page context (unverified) with the session', async () => {
    const server = fakeServer();
    const client = clientFor(server, { context: { plan: 'gold', cartItems: 3, returning: true } });
    await client.connect();
    expect(server.calls('POST /session')[0]?.body).toEqual({ context: { plan: 'gold', cartItems: 3, returning: true } });
    expect(client.getState().authenticated).toBe(false);
  });

  it('client: without a session pass the server refuses and the state shows the error', async () => {
    const server = fakeServer({ mode: 'client' });
    const client = clientFor(server, { mode: 'client' });
    await expect(client.connect()).rejects.toMatchObject({ status: 401, code: 'session_pass_required' });
    expect(client.getState()).toMatchObject({ status: 'error', error: { code: 'session_pass_required' } });
  });

  it('client: asks the host for a fresh pass before every session exchange', async () => {
    const server = fakeServer({ mode: 'client' });
    const getSessionPass = vi.fn(async () => server.mintPass());
    const storage = memoryStorage();
    const client = clientFor(server, { mode: 'client', getSessionPass, storage });
    await client.connect();
    expect(client.getState().status).toBe('ready');
    client.disconnect();
    const again = clientFor(server, { mode: 'client', getSessionPass, storage });
    await again.connect();
    expect(getSessionPass).toHaveBeenCalledTimes(2);
    const [first, second] = server.calls('POST /session').map((r) => r.body as { sessionPass: string; visitorToken?: string });
    expect(first?.sessionPass).toMatch(/^wsp1\./);
    expect(second?.sessionPass).not.toBe(first?.sessionPass);
    expect(second?.visitorToken).toMatch(/^wcv1\.v_1\./);
  });

  it('client: an expired/used pass is replaced once', async () => {
    const server = fakeServer({ mode: 'client' });
    let calls = 0;
    const getSessionPass = vi.fn(async () => (++calls === 1 ? 'wsp1.stale' : server.mintPass()));
    const client = clientFor(server, { getSessionPass });
    await client.connect();
    expect(getSessionPass).toHaveBeenCalledTimes(2);
    expect(server.calls('POST /session')).toHaveLength(2);
    expect(client.getState().status).toBe('ready');
  });

  it('client: a 401 on the data API renews the session with a new pass', async () => {
    const server = fakeServer({ mode: 'client' });
    const getSessionPass = vi.fn(async () => server.mintPass());
    const client = clientFor(server, { getSessionPass });
    await client.connect();
    server.fail('POST /messages', { status: 401, code: 'webchat_token_expired' });
    await client.send('hi');
    expect(getSessionPass).toHaveBeenCalledTimes(2);
  });

  it('user: a pass minted for a verified user authenticates the session', async () => {
    const server = fakeServer({ mode: 'user' });
    const client = clientFor(server, { mode: 'user', getSessionPass: async () => server.mintPass('cus_42') });
    await client.connect();
    expect(client.getState().authenticated).toBe(true);
  });

  it('user: the user token from getUserToken is sent and verified', async () => {
    const server = fakeServer({ mode: 'user' });
    const client = clientFor(server, { getUserToken: async () => 'good.cus_7' });
    await client.connect();
    expect((server.calls('POST /session')[0]?.body as { userToken: string }).userToken).toBe('good.cus_7');
    expect(client.getState().authenticated).toBe(true);
  });

  it('user: no signed-in user → user_token_required', async () => {
    const server = fakeServer({ mode: 'user' });
    const client = clientFor(server, { getUserToken: async () => null });
    await expect(client.connect()).rejects.toMatchObject({ code: 'user_token_required' });
  });

  it('identify() upgrades the visitor, clears the old view and emits identified', async () => {
    const server = fakeServer();
    const client = clientFor(server);
    await client.connect();
    await client.send('as a guest');
    const identified = vi.fn();
    client.on('identified', identified);
    await client.identify('good.cus_9');
    const body = server.calls('POST /session').at(-1)?.body as { userToken: string; visitorToken: string };
    expect(body.userToken).toBe('good.cus_9');
    expect(body.visitorToken).toMatch(/^wcv1\.v_1\./);
    expect(identified).toHaveBeenCalledWith({ authenticated: true });
    expect(client.getState().authenticated).toBe(true);
  });

  it('user: after identify() (no getUserToken) reconnects re-prove the user with the same token', async () => {
    const server = fakeServer({ mode: 'user' });
    const client = clientFor(server);
    await expect(client.connect()).rejects.toMatchObject({ code: 'user_token_required' });
    await client.identify('good.cus_5');
    expect(client.getState()).toMatchObject({ status: 'ready', authenticated: true });
    client.disconnect();
    await client.connect();
    expect(client.getState()).toMatchObject({ status: 'ready', authenticated: true });
    expect((server.calls('POST /session').at(-1)?.body as { userToken?: string }).userToken).toBe('good.cus_5');
    await client.reset().catch(() => undefined);
    expect((server.calls('POST /session').at(-1)?.body as { userToken?: string }).userToken).toBeUndefined();
  });

  it('anonymous: a stale identified token is dropped on renewal and the session still opens', async () => {
    const server = fakeServer();
    const client = clientFor(server);
    await client.connect();
    await client.identify('good.cus_6');
    client.disconnect();
    // The token expired meanwhile: the server rejects it on the next exchange.
    server.fail('POST /session', { status: 401, code: 'user_token_invalid' });
    await client.connect();
    expect(client.getState().status).toBe('ready');
    const last = server.calls('POST /session').at(-1)?.body as { userToken?: string; visitorToken?: string };
    expect(last.userToken).toBeUndefined();
    expect(last.visitorToken).toMatch(/^wcv1\./);
  });

  it('identify() with a rejected token keeps the session and reports the error', async () => {
    const server = fakeServer();
    const client = clientFor(server);
    await client.connect();
    await expect(client.identify('bad.token')).rejects.toMatchObject({ code: 'user_token_invalid' });
    expect(client.getState().error?.code).toBe('user_token_invalid');
    expect(client.getState().authenticated).toBe(false);
  });

  it('reset() forgets the visitor and starts over', async () => {
    const server = fakeServer();
    const storage = memoryStorage();
    const client = clientFor(server, { storage });
    await client.connect();
    await client.identify('good.cus_1');
    await client.reset();
    expect(server.calls('POST /session').at(-1)?.body).toEqual({});
    expect(client.getState().authenticated).toBe(false);
    expect(client.getState().messages).toEqual([]);
    const stored = JSON.parse(String(await storage.get(`ocso.chat.${server.publishableKey}.session`))) as { token: string };
    expect(stored.token).toMatch(/^wcv1\.v_2\./);
  });

  it('a different signed-in user on the same device never continues the stored visitor (getUserToken)', async () => {
    const server = fakeServer({ mode: 'user' });
    const storage = memoryStorage();
    let who = 'alice';
    const getUserToken = async () => (who ? jwtFor(who) : null);
    const first = clientFor(server, { storage, getUserToken });
    await first.connect();
    first.disconnect();
    // Alice again (a reload): the visitor continues.
    const again = clientFor(server, { storage, getUserToken });
    await again.connect();
    again.disconnect();
    expect(lastSession(server).visitorToken).toMatch(/^wcv1\.v_1\./);
    // Alice left without reset(); Bob signs in on the same browser.
    who = 'bob';
    const bob = clientFor(server, { storage, getUserToken });
    await bob.connect();
    expect(lastSession(server).visitorToken).toBeUndefined();
    expect(lastSession(server).userToken).toBe(jwtFor('bob'));
    const stored = JSON.parse(String(await storage.get(`ocso.chat.${server.publishableKey}.session`))) as { token: string; subject: string };
    expect(stored).toMatchObject({ token: expect.stringMatching(/^wcv1\.v_2\./), subject: 'bob' });
    bob.disconnect();
    // Signed out (getUserToken says nobody): the signed-in visitor is not continued either.
    who = '';
    const nobody = clientFor(server, { storage, getUserToken });
    await nobody.connect().catch(() => undefined);
    expect(lastSession(server).visitorToken).toBeUndefined();
  });

  it('identify() with a different user drops the stored visitor; the same user keeps it', async () => {
    const server = fakeServer();
    const storage = memoryStorage();
    const client = clientFor(server, { storage });
    await client.connect();
    await client.identify(jwtFor('alice'));
    expect(lastSession(server).visitorToken).toMatch(/^wcv1\.v_1\./); // the guest signs in: same visitor
    await client.identify(jwtFor('alice'));
    expect(lastSession(server).visitorToken).toMatch(/^wcv1\.v_1\./);
    client.disconnect();
    // A reload (no identify yet, anonymous renewal) still remembers whose session it is.
    const reloaded = clientFor(server, { storage });
    await reloaded.connect();
    expect(lastSession(server).visitorToken).toMatch(/^wcv1\.v_1\./);
    await reloaded.identify(jwtFor('bob'));
    expect(lastSession(server).visitorToken).toBeUndefined();
    expect(reloaded.getState().authenticated).toBe(true);
  });

  it('reads the user hint from a JWT or a session pass (unverified; opaque tokens give no hint)', () => {
    const pass = (claims: Record<string, unknown>) => `wsp1.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.mac`;
    expect(subjectHint({ userToken: jwtFor('ü-42') })).toBe('ü-42');
    expect(subjectHint({ sessionPass: pass({ ch: 'c', sub: 'cus_1' }) })).toBe('cus_1');
    expect(subjectHint({ sessionPass: pass({ ch: 'c' }) })).toBeNull();
    expect(subjectHint({})).toBeNull();
    expect(subjectHint({ userToken: 'good.cus_7' })).toBeUndefined();
    expect(subjectHint({ sessionPass: 'wsp1.stale' })).toBeUndefined();
  });

  it('rateCsat posts the score for the current conversation', async () => {
    const server = fakeServer();
    const client = clientFor(server);
    await client.connect();
    await expect(client.rateCsat(4, 'quick')).resolves.toMatchObject({ recorded: true, score: 4 });
    expect(server.calls('POST /csat')[0]?.body).toEqual({ score: 4, comment: 'quick' });
    await expect(client.rateCsat(9 as 5)).rejects.toMatchObject({ code: 'invalid_score' });
  });

  it('rejects an invalid publishable key up front', () => {
    expect(() => createOcsoChat({ baseUrl: 'https://x.test', publishableKey: 'bad key', fetch: async () => new Response() })).toThrow(/publishableKey/);
  });
});
