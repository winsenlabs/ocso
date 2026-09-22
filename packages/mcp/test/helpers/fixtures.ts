import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CredentialPort, EgressPolicy, McpConnectionTarget, McpServiceDeps, TokensRefreshedEvent } from '../../src/index.js';

/** Loopback test servers are "internal": allowlist them explicitly, as a compose deployment would. */
export const LOCAL_POLICY: EgressPolicy = { allowedInternalHosts: ['127.0.0.1'], allowInsecureHttpHosts: ['127.0.0.1'] };

export class InMemoryCredentials implements CredentialPort {
  readonly secrets = new Map<string, string>();
  readonly refreshed: TokensRefreshedEvent[] = [];
  resolveCalls = 0;

  constructor(entries: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(entries)) this.secrets.set(k, v);
  }

  async resolve(ref: string): Promise<string> {
    this.resolveCalls++;
    const v = this.secrets.get(ref);
    if (v === undefined) throw new Error(`secret ${ref} not found`);
    return v;
  }

  async onTokensRefreshed(event: TokensRefreshedEvent): Promise<void> {
    this.refreshed.push(event);
    this.secrets.set(event.tokenRef, event.serialized);
  }
}

export function deps(credentials: CredentialPort = new InMemoryCredentials(), egress: EgressPolicy = LOCAL_POLICY): McpServiceDeps {
  return { credentials, egress };
}

export function target(url: string, over: Partial<McpConnectionTarget> = {}): McpConnectionTarget {
  return { id: 'conn-meridian', name: 'meridian-core', url, network: 'INTERNAL', auth: { strategy: 'NONE' }, ...over };
}

export interface RunningServer {
  server: http.Server;
  port: number;
  origin: string;
  close(): Promise<void>;
}

/** Listen on an ephemeral loopback port first, so handlers can be built with the final URL. */
export async function listen(handler?: http.RequestListener): Promise<RunningServer> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
