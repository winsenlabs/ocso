import { createGuardedFetch, type FetchFn, type GuardedFetch } from '@ocso/mcp';
import type { DbOrTx } from '@ocso/db';
import { loadEgressPolicy } from '../mcp/egress.js';

/**
 * Network egress of channel adapters (provider APIs, media downloads): the
 * SSRF-guarded fetch MCP uses (ADR-021). Provider hosts are public https
 * (graph.facebook.com, api.twilio.com, content.twilio.com, their media
 * CDNs); private and loopback addresses are refused unless the Tech Admin
 * allowlisted the host (deployment settings, the same list INTERNAL MCP
 * connections use, e.g. a provider stub in Compose). Channel base URLs are
 * admin-entered settings, so this is what keeps them from reaching the
 * internal network.
 */

/** WhatsApp documents may be 100 MB; adapters enforce each media kind's own limit while streaming. */
const MAX_RESPONSE_BYTES = 101 * 1024 * 1024;
const POLICY_TTL_MS = 10_000;

export interface ChannelEgress extends GuardedFetch {}

export function createChannelEgress(options: { db?: DbOrTx | undefined; now?: () => number } = {}): ChannelEgress {
  const now = options.now ?? Date.now;
  const limits = { maxResponseBytes: MAX_RESPONSE_BYTES };
  const publicOnly = createGuardedFetch({ policy: { allowedInternalHosts: [], allowInsecureHttpHosts: [] }, network: 'PUBLIC', limits });
  let internal: { key: string; guarded: GuardedFetch } | null = null;
  let cached: { at: number; hosts: readonly string[] } | null = null;

  const allowlist = async (): Promise<readonly string[]> => {
    if (!options.db) return [];
    if (cached && now() - cached.at < POLICY_TTL_MS) return cached.hosts;
    const policy = await loadEgressPolicy(options.db, 'INTERNAL');
    cached = { at: now(), hosts: policy.allowedInternalHosts };
    return cached.hosts;
  };

  const guardedFor = async (): Promise<GuardedFetch> => {
    const hosts = await allowlist();
    if (!hosts.length) return publicOnly;
    const key = hosts.join('\n');
    if (internal?.key !== key) {
      internal?.guarded.close();
      internal = { key, guarded: createGuardedFetch({ policy: { allowedInternalHosts: hosts, allowInsecureHttpHosts: hosts }, network: 'INTERNAL', limits }) };
    }
    return internal.guarded;
  };

  const fetch: FetchFn = async (input, init) => (await guardedFor()).fetch(input, init);
  return {
    fetch,
    close() {
      publicOnly.close();
      internal?.guarded.close();
    },
  };
}
