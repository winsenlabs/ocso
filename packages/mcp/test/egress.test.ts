import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  classifyAddress,
  createGuardedFetch,
  EgressBlockedError,
  hostMatches,
  McpNetworkError,
  type DnsResolver,
  type EgressPolicy,
  type McpNetwork,
} from '../src/index.js';
import { LOCAL_POLICY, listen, type RunningServer } from './helpers/fixtures.js';

const STRICT: EgressPolicy = { allowedInternalHosts: [], allowInsecureHttpHosts: [] };

function guarded(policy: EgressPolicy, network: McpNetwork = 'PUBLIC', resolver?: DnsResolver, limits = {}) {
  return createGuardedFetch({ policy, network, resolver, limits });
}

async function blockedReason(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EgressBlockedError);
  return (err as EgressBlockedError).reason;
}

describe('address classification', () => {
  it.each([
    ['169.254.169.254', 'FORBIDDEN'],
    ['169.254.170.2', 'FORBIDDEN'],
    ['0.0.0.0', 'FORBIDDEN'],
    ['224.0.0.251', 'FORBIDDEN'],
    ['255.255.255.255', 'FORBIDDEN'],
    ['::', 'FORBIDDEN'],
    ['fe80::1', 'FORBIDDEN'],
    ['ff02::1', 'FORBIDDEN'],
    ['::ffff:10.0.0.1', 'FORBIDDEN'],
    ['::ffff:8.8.8.8', 'FORBIDDEN'],
    ['::ffff:7f00:1', 'FORBIDDEN'],
    ['::a00:1', 'FORBIDDEN'],
    ['64:ff9b::a00:1', 'FORBIDDEN'],
    ['2002:a00:1::1', 'FORBIDDEN'],
    ['127.0.0.1', 'INTERNAL'],
    ['::1', 'INTERNAL'],
    ['10.20.30.40', 'INTERNAL'],
    ['172.17.0.2', 'INTERNAL'],
    ['192.168.1.10', 'INTERNAL'],
    ['100.64.0.1', 'INTERNAL'],
    ['fd12:3456::1', 'INTERNAL'],
    ['8.8.8.8', 'PUBLIC'],
    ['93.184.216.34', 'PUBLIC'],
    ['2606:4700:4700::1111', 'PUBLIC'],
    ['not-an-ip', 'FORBIDDEN'],
  ])('%s → %s', (ip, expected) => {
    expect(classifyAddress(ip)).toBe(expected);
  });

  it('matches hosts exactly or by *.suffix wildcard, case-insensitively', () => {
    expect(hostMatches('MCP.Internal.Corp', ['mcp.internal.corp'])).toBe(true);
    expect(hostMatches('a.b.internal.corp', ['*.internal.corp'])).toBe(true);
    expect(hostMatches('internal.corp', ['*.internal.corp'])).toBe(false);
    expect(hostMatches('[::1]', ['0:0:0:0:0:0:0:1'])).toBe(true);
    expect(hostMatches('evilinternal.corp', ['*.internal.corp'])).toBe(false);
  });
});

describe('guarded fetch: static URL checks (no network)', () => {
  const g = guarded({ allowedInternalHosts: ['169.254.169.254'], allowInsecureHttpHosts: ['169.254.169.254'] }, 'INTERNAL');
  afterAll(() => g.close());

  it('blocks the cloud metadata IP even when allowlisted and INTERNAL', async () => {
    expect(await blockedReason(g.fetch('http://169.254.169.254/latest/meta-data/'))).toBe('forbidden_address');
  });

  it('blocks loopback / private literals for PUBLIC connections and IPv4-mapped IPv6 always', async () => {
    const pub = guarded(STRICT);
    expect(await blockedReason(pub.fetch('https://127.0.0.1/mcp'))).toBe('private_address');
    expect(await blockedReason(pub.fetch('https://10.0.0.8/mcp'))).toBe('private_address');
    expect(await blockedReason(pub.fetch('https://[::ffff:10.0.0.1]/mcp'))).toBe('forbidden_address');
    expect(await blockedReason(pub.fetch('https://[::ffff:127.0.0.1]/mcp'))).toBe('forbidden_address');
    expect(await blockedReason(pub.fetch('https://2130706433/mcp'))).toBe('private_address'); // 127.0.0.1 in decimal
    pub.close();
  });

  it('is https-only unless the host is allowlisted for http, and rejects userinfo and odd schemes', async () => {
    const pub = guarded(STRICT);
    expect(await blockedReason(pub.fetch('http://example.com/mcp'))).toBe('insecure_scheme');
    expect(await blockedReason(pub.fetch('ftp://example.com/mcp'))).toBe('insecure_scheme');
    expect(await blockedReason(pub.fetch('https://user:secret@example.com/mcp'))).toBe('credentials_in_url');
    expect(await blockedReason(pub.fetch('not a url'))).toBe('invalid_url');
    pub.close();
  });

  it('blocks hostnames whose DNS answers include a private or forbidden address', async () => {
    const resolver: DnsResolver = async (host) =>
      host === 'evil.example'
        ? [{ address: '10.0.0.5', family: 4 }]
        : host === 'mixed.example'
          ? [
              { address: '93.184.216.34', family: 4 },
              { address: '169.254.169.254', family: 4 },
            ]
          : [{ address: 'fd00::7', family: 6 }];
    const pub = guarded(STRICT, 'PUBLIC', resolver);
    expect(await blockedReason(pub.fetch('https://evil.example/mcp'))).toBe('private_address');
    expect(await blockedReason(pub.fetch('https://mixed.example/mcp'))).toBe('forbidden_address');
    expect(await blockedReason(pub.fetch('https://ula.example/mcp'))).toBe('private_address');
    pub.close();
  });

  it('resolves real DNS too: localhost is private unless allowlisted', async () => {
    const pub = guarded({ allowedInternalHosts: [], allowInsecureHttpHosts: ['localhost'] }, 'INTERNAL');
    expect(await blockedReason(pub.fetch('http://localhost:9/mcp'))).toBe('private_address');
    pub.close();
  });
});

describe('guarded fetch: live exchanges on loopback', () => {
  let a: RunningServer;
  let b: RunningServer;
  let lastHeadersAtB: http.IncomingHttpHeaders = {};

  beforeAll(async () => {
    b = await listen((req, res) => {
      lastHeadersAtB = req.headers;
      res.writeHead(200, { 'content-type': 'text/plain' }).end('b');
    });
    a = await listen((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      switch (url.pathname) {
        case '/ok':
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
          return;
        case '/echo': {
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => res.writeHead(200).end(JSON.stringify({ ct: req.headers['content-type'], body: Buffer.concat(chunks).toString() })));
          return;
        }
        case '/to-metadata':
          res.writeHead(302, { location: 'https://169.254.169.254/latest/meta-data/' }).end();
          return;
        case '/to-localhost':
          res.writeHead(302, { location: `http://localhost:${b.port}/` }).end();
          return;
        case '/to-b':
          res.writeHead(302, { location: `${b.origin}/landing` }).end();
          return;
        case '/loop':
          res.writeHead(302, { location: '/loop' }).end();
          return;
        case '/post-redirect':
          res.writeHead(307, { location: `${b.origin}/` }).end();
          return;
        case '/big':
          res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.alloc(64 * 1024, 1));
          return;
        case '/hang':
          return; // never answers
        default:
          res.writeHead(404).end();
      }
    });
  });
  afterAll(async () => {
    await a.close();
    await b.close();
  });

  const local = (limits = {}) => guarded({ ...LOCAL_POLICY, allowInsecureHttpHosts: ['127.0.0.1', 'localhost'] }, 'INTERNAL', undefined, limits);

  it('reaches an allowlisted internal host on an INTERNAL connection', async () => {
    const g = local();
    const res = await g.fetch(`${a.origin}/ok`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    g.close();
  });

  it('refuses the same host when the connection is PUBLIC', async () => {
    const g = guarded(LOCAL_POLICY, 'PUBLIC');
    expect(await blockedReason(g.fetch(`${a.origin}/ok`))).toBe('private_address');
    g.close();
  });

  it('serializes request bodies (URLSearchParams) like fetch', async () => {
    const g = local();
    const res = await g.fetch(`${a.origin}/echo`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token' }) });
    expect(await res.json()).toEqual({ ct: 'application/x-www-form-urlencoded;charset=UTF-8', body: 'grant_type=refresh_token' });
    g.close();
  });

  it('re-validates every redirect hop: literal metadata IP and a hostname resolving to loopback are blocked', async () => {
    const g = local();
    expect(await blockedReason(g.fetch(`${a.origin}/to-metadata`))).toBe('forbidden_address');
    expect(await blockedReason(g.fetch(`${a.origin}/to-localhost`))).toBe('private_address');
    g.close();
  });

  it('drops credentials on cross-origin redirects and caps the hop count', async () => {
    const g = local();
    const res = await g.fetch(`${a.origin}/to-b`, { headers: { authorization: 'Bearer top-secret', 'x-api-key': 'k', accept: 'text/plain' } });
    expect(await res.text()).toBe('b');
    expect(lastHeadersAtB.authorization).toBeUndefined();
    expect(lastHeadersAtB['x-api-key']).toBeUndefined();
    expect(lastHeadersAtB.accept).toBe('text/plain');
    expect(await blockedReason(g.fetch(`${a.origin}/loop`))).toBe('too_many_redirects');
    g.close();
  });

  it('never follows redirects for POST', async () => {
    const g = local();
    const res = await g.fetch(`${a.origin}/post-redirect`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(307);
    g.close();
  });

  it('caps response size', async () => {
    const g = local({ maxResponseBytes: 16 * 1024 });
    const res = await g.fetch(`${a.origin}/big`);
    const err = await res.arrayBuffer().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpNetworkError);
    expect((err as McpNetworkError).reason).toBe('response_too_large');
    g.close();
  });

  it('enforces idle timeouts, the default whole-request deadline and caller aborts', async () => {
    const idle = local({ idleTimeoutMs: 150 });
    await expect(idle.fetch(`${a.origin}/hang`)).rejects.toMatchObject({ reason: 'timeout' });
    idle.close();
    const whole = local({ defaultRequestTimeoutMs: 150 });
    await expect(whole.fetch(`${a.origin}/hang`)).rejects.toMatchObject({ name: 'TimeoutError' });
    whole.close();
    const g = local();
    const ac = new AbortController();
    const p = g.fetch(`${a.origin}/hang`, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    g.close();
  });

  it('reports connection refusal as a typed network error', async () => {
    const dead = await listen();
    const origin = dead.origin;
    await dead.close();
    const g = local();
    await expect(g.fetch(`${origin}/ok`)).rejects.toMatchObject({ reason: 'connect_failed', errno: 'ECONNREFUSED' });
    g.close();
  });
});
