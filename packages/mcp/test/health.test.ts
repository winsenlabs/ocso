import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpHealthService } from '../src/index.js';
import { startLegacyServer, startStatusServer, type McpTestServer } from './helpers/custom-servers.js';
import { startDemo, type DemoServer } from './helpers/demo-server.js';
import { deps, InMemoryCredentials, listen, target } from './helpers/fixtures.js';

describe('McpHealthService', () => {
  let modern: DemoServer;
  let bearer: DemoServer;
  let legacy: McpTestServer;
  const health = new McpHealthService(deps());

  beforeAll(async () => {
    modern = await startDemo();
    bearer = await startDemo({ mode: 'bearer', token: 'health-check-token-123456' });
    legacy = await startLegacyServer();
  });
  afterAll(async () => {
    await modern.close();
    await bearer.close();
    await legacy.close();
  });

  it('is HEALTHY on a 2026 server via server/discover', async () => {
    const r = await health.health(target(modern.url));
    expect(r).toMatchObject({ status: 'HEALTHY', protocolEra: 'modern', protocolVersion: '2026-07-28', detail: 'ok' });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(r.connectMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(r.checkedAt)).not.toBeNaN();
  });

  it('uses ping on a 2025-era server', async () => {
    const r = await health.health(target(legacy.url));
    expect(r).toMatchObject({ status: 'HEALTHY', protocolEra: 'legacy', detail: 'ok' });
    expect(r.protocolVersion).toMatch(/^2025-/);
  });

  it('is DEGRADED when slower than the configured threshold', async () => {
    const r = await health.health(target(modern.url), { degradedLatencyMs: -1 });
    expect(r).toMatchObject({ status: 'DEGRADED', detail: 'slow_response' });
  });

  it('is AUTH_REQUIRED when the server rejects the request, and HEALTHY with the right credentials', async () => {
    const r = await health.health(target(bearer.url));
    expect(r).toMatchObject({ status: 'AUTH_REQUIRED', detail: 'unauthorized', latencyMs: null });
    expect(r.authRequired?.oauthAvailable).toBe(false);
    const creds = new InMemoryCredentials({ 'secret://h': 'health-check-token-123456' });
    const ok = await new McpHealthService(deps(creds)).health(
      target(bearer.url, { auth: { strategy: 'HEADER', headerName: 'Authorization', tokenRef: 'secret://h' } }),
    );
    expect(ok.status).toBe('HEALTHY');
  });

  it('is DOWN (never throws) for unreachable, 5xx, hanging, blocked and malformed targets', async () => {
    const dead = await startDemo();
    await dead.close();
    expect(await health.health(target(dead.url))).toMatchObject({ status: 'DOWN', detail: 'unreachable' });

    const broken = await startStatusServer(502);
    expect(await health.health(target(broken.url))).toMatchObject({ status: 'DOWN', detail: 'http_502' });
    await broken.close();

    const hang = await listen(() => undefined);
    expect(await health.health(target(`${hang.origin}/mcp`), { timeoutMs: 200 })).toMatchObject({ status: 'DOWN', detail: 'timeout' });
    await hang.close();

    expect(await health.health(target(modern.url, { network: 'PUBLIC' }))).toMatchObject({ status: 'DOWN', detail: 'egress_blocked:private_address' });
    expect(await health.health(target('::not a url::'))).toMatchObject({ status: 'DOWN', detail: 'egress_blocked:invalid_url' });
  });
});
