import { eq } from 'drizzle-orm';
import { deploymentSettings, type DbOrTx } from '@ocso/db';
import type { EgressPolicy, McpNetwork } from '@ocso/mcp';

const NO_INTERNAL: EgressPolicy = { allowedInternalHosts: [], allowInsecureHttpHosts: [] };

/**
 * Outbound policy for one connection (docs/15 §5, ADR-021). Only INTERNAL
 * connections may reach the Tech admin's allowlisted private hosts; those
 * hosts may also use plain http (Compose service names have no TLS). Every
 * other destination is public https only.
 */
export function egressPolicyFor(allowedInternalHosts: readonly string[], network: McpNetwork): EgressPolicy {
  if (network !== 'INTERNAL' || allowedInternalHosts.length === 0) return NO_INTERNAL;
  const hosts = allowedInternalHosts.map((h) => h.trim()).filter(Boolean);
  return { allowedInternalHosts: hosts, allowInsecureHttpHosts: hosts };
}

export async function loadEgressPolicy(db: DbOrTx, network: McpNetwork): Promise<EgressPolicy> {
  if (network !== 'INTERNAL') return NO_INTERNAL;
  const [row] = await db
    .select({ hosts: deploymentSettings.egressAllowedInternalHosts })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.id, 1));
  return egressPolicyFor(row?.hosts ?? [], network);
}
