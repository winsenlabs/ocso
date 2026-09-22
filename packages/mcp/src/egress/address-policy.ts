import net from 'node:net';
import type { EgressPolicy, McpNetwork } from '../types.js';

/**
 * IP classification for the SSRF guard (research/03 §5), built on Node's
 * `net.BlockList` instead of hand-rolled parsing.
 *
 * - FORBIDDEN: never reachable, not even for allowlisted internal hosts —
 *   link-local (169.254/16 incl. cloud metadata, fe80::/10), unspecified,
 *   multicast/broadcast, reserved/documentation ranges, IPv4-mapped and
 *   IPv4-embedding IPv6 forms (mapped, compatible, NAT64, 6to4, Teredo).
 * - INTERNAL: loopback, RFC 1918, CGNAT, IPv6 ULA — reachable only by
 *   `INTERNAL` connections whose host is allowlisted.
 * - PUBLIC: everything else.
 */
export type AddressClass = 'PUBLIC' | 'INTERNAL' | 'FORBIDDEN';

const FORBIDDEN_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['169.254.0.0', 16],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const FORBIDDEN_V6: Array<[string, number]> = [
  ['::', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];
const INTERNAL_V4: Array<[string, number]> = [
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
];
const INTERNAL_V6: Array<[string, number]> = [
  ['::1', 128],
  ['fc00::', 7],
];

function blockList(v4: Array<[string, number]>, v6: Array<[string, number]>): net.BlockList {
  const list = new net.BlockList();
  for (const [a, p] of v4) list.addSubnet(a, p, 'ipv4');
  for (const [a, p] of v6) list.addSubnet(a, p, 'ipv6');
  return list;
}

const FORBIDDEN = blockList(FORBIDDEN_V4, FORBIDDEN_V6);
// IPv4-compatible IPv6 (::a.b.c.d, excluding :: and ::1) embeds IPv4 and is deprecated.
FORBIDDEN.addRange('::2', '::ffff:ffff', 'ipv6');
const INTERNAL = blockList(INTERNAL_V4, INTERNAL_V6);
// Queried for IPv6 addresses only: a mapped-subnet rule would also match plain IPv4 queries.
const MAPPED = new net.BlockList();
MAPPED.addSubnet('::ffff:0:0', 96, 'ipv6');

export function classifyAddress(ip: string): AddressClass {
  const family = net.isIP(ip);
  if (family === 0) return 'FORBIDDEN';
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (type === 'ipv6' && MAPPED.check(ip, 'ipv6')) return 'FORBIDDEN';
  if (FORBIDDEN.check(ip, type)) return 'FORBIDDEN';
  if (INTERNAL.check(ip, type)) return 'INTERNAL';
  return 'PUBLIC';
}

/** Strip IPv6 brackets and lowercase; canonicalize IPv6 literals so `0:0::1` matches `::1`. */
export function normalizeHost(host: string): string {
  const bare = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (net.isIPv6(bare)) {
    try {
      return new URL(`http://[${bare}]/`).hostname.replace(/^\[(.*)\]$/, '$1');
    } catch {
      return bare;
    }
  }
  return bare.replace(/\.$/, '');
}

/** Exact match, or `*.suffix` matching any subdomain of `suffix` (not the apex). */
export function hostMatches(host: string, patterns: readonly string[]): boolean {
  const h = normalizeHost(host);
  return patterns.some((raw) => {
    const p = raw.trim().toLowerCase();
    if (p.startsWith('*.')) {
      const suffix = p.slice(1);
      return h.endsWith(suffix) && h.length > suffix.length;
    }
    return normalizeHost(p) === h;
  });
}

export interface HostVerdict {
  /** Internal (private/loopback) addresses are acceptable for this host. */
  internalAllowed: boolean;
  /** Plain http is acceptable for this host. */
  insecureHttpAllowed: boolean;
}

export function hostVerdict(host: string, network: McpNetwork, policy: EgressPolicy): HostVerdict {
  return {
    internalAllowed: network === 'INTERNAL' && hostMatches(host, policy.allowedInternalHosts),
    insecureHttpAllowed: hostMatches(host, policy.allowInsecureHttpHosts),
  };
}

/** Whether a concrete IP may be dialled for a host with the given verdict. */
export function addressAllowed(ip: string, verdict: HostVerdict): 'ok' | 'forbidden_address' | 'private_address' {
  const cls = classifyAddress(ip);
  if (cls === 'FORBIDDEN') return 'forbidden_address';
  if (cls === 'INTERNAL' && !verdict.internalAllowed) return 'private_address';
  return 'ok';
}
