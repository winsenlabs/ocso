import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ChallengeRecorder } from '../auth/challenge.js';
import { assertUrlAllowed, createGuardedFetch, type FetchFn } from '../egress/guarded-fetch.js';
import { EgressBlockedError } from '../errors.js';
import type { McpConnectionTarget, McpServiceDeps } from '../types.js';
import { CredentialSession } from './credential-session.js';

export const DEFAULT_CLIENT_IDENTITY = { name: 'ocso', version: '0.1.0' } as const;

export interface ClientConnectOptions {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export interface McpClientHandle {
  readonly target: McpConnectionTarget;
  readonly client: Client;
  readonly session: CredentialSession;
  readonly challenges: ChallengeRecorder;
  /** Guarded fetch WITHOUT credentials (PRM / metadata discovery). */
  readonly plainFetch: FetchFn;
  connect(options: ClientConnectOptions): Promise<void>;
  /** 'modern' (2026-07-28+, stateless) or 'legacy' (2025 handshake); null before connect. */
  era(): 'modern' | 'legacy' | null;
  protocolVersion(): string | null;
  close(): Promise<void>;
}

export interface ClientHandleOptions {
  /** Cap on pages walked by `listTools()` auto-aggregation. Default 20. */
  listMaxPages?: number | undefined;
}

/**
 * Build a v2 MCP client for a connection (ADR-021): `'auto'` version
 * negotiation (2026-07-28 `server/discover`, falling back to the 2025
 * handshake), no client capabilities, no auto-fulfilment of server input
 * requests, a guarded fetch, and credentials injected from the
 * CredentialPort only onto outbound requests. `onInsufficientScope: 'throw'`
 * so step-up stays behind an admin action.
 */
export function createClientHandle(target: McpConnectionTarget, deps: McpServiceDeps, options: ClientHandleOptions = {}): McpClientHandle {
  let url: URL;
  try {
    url = new URL(target.url);
  } catch {
    throw new EgressBlockedError('invalid_url', null);
  }
  assertUrlAllowed(url, deps.egress, target.network);

  const guarded = createGuardedFetch({ policy: deps.egress, network: target.network, limits: deps.limits, resolver: deps.resolver });
  const session = new CredentialSession(target, deps.credentials, guarded.fetch);
  const challenges = new ChallengeRecorder();
  const identity = deps.clientIdentity ?? DEFAULT_CLIENT_IDENTITY;
  const client = new Client(
    { name: identity.name, version: identity.version },
    {
      capabilities: {},
      versionNegotiation: { mode: 'auto' },
      inputRequired: { autoFulfill: false },
      listMaxPages: options.listMaxPages ?? 20,
    },
  );
  const authProvider = session.authProvider();
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: session.wrapFetch(challenges.wrap(guarded.fetch)),
    ...(authProvider ? { authProvider } : {}),
    onInsufficientScope: 'throw',
  });
  // Transport-level errors are surfaced through the awaited calls; keep the default console quiet.
  client.onerror = () => undefined;
  let closed = false;

  return {
    target,
    client,
    session,
    challenges,
    plainFetch: guarded.fetch,
    async connect(opts) {
      await client.connect(transport, { timeout: opts.timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) });
    },
    era: () => client.getProtocolEra() ?? null,
    protocolVersion: () => client.getNegotiatedProtocolVersion() ?? null,
    async close() {
      if (closed) return;
      closed = true;
      // Sessionful 2025-era servers: release the session explicitly (stateless/modern servers have none).
      if (transport.sessionId) await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
      guarded.close();
    },
  };
}
