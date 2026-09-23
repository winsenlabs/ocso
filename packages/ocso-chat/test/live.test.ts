import { describe, expect, it } from 'vitest';
import { ChatApi, ChatApiError } from '../src/api.js';
import { SseConnection, type LiveState } from '../src/live.js';
import { fakeServer, until } from './helpers/fake-server.js';

const fast = { baseMs: 1, maxMs: 2, jitter: 0 };

function sse(server: ReturnType<typeof fakeServer>, token: () => string | null, onUnauthorized: () => Promise<void>) {
  const fatal: ChatApiError[] = [];
  const states: LiveState[] = [];
  const conn = new SseConnection({
    api: new ChatApi(server.baseUrl, server.publishableKey, server.fetch),
    token,
    onEvent: () => undefined,
    onUnsupported: () => undefined,
    onState: (s) => states.push(s),
    onUnauthorized,
    onFatal: (e) => fatal.push(e),
    backoff: fast,
  });
  return { conn, fatal, states };
}

describe('SSE loop: giving up', () => {
  it('stops after repeated 401s even though every renewal succeeds (misbound token)', async () => {
    const server = fakeServer();
    server.fail('GET /stream', { status: 401, code: 'webchat_token_invalid' }, 50);
    let renewals = 0;
    const { conn, fatal, states } = sse(server, () => 'wcv1.x.y', async () => void renewals++);
    conn.start();
    await until(() => fatal.length === 1);
    expect(fatal[0]).toMatchObject({ status: 401, code: 'webchat_token_invalid' });
    expect(renewals).toBe(3);
    expect(server.calls('GET /stream')).toHaveLength(4);
    expect(states.at(-1)?.status).toBe('stopped');
  });

  it('keeps retrying transient failures (503, 429, network)', async () => {
    const server = fakeServer();
    server.fail('GET /stream', { status: 503, code: 'unavailable' }, 2);
    server.fail('GET /stream', { status: 429, code: 'rate_limited' }, 1);
    const session = await new ChatApi(server.baseUrl, server.publishableKey, server.fetch).session({});
    const { conn, fatal } = sse(server, () => session.token, async () => undefined);
    conn.start();
    await until(() => server.openStreams === 1);
    expect(fatal).toEqual([]);
    conn.stop();
  });
});
