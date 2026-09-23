import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@ocso/db';
import { at, int, iso, ratio, rounded } from '../analytics/values.js';

export interface McpHealthRow {
  connectionId: string;
  name: string;
  description: string | null;
  /** Host and path only — never query strings or credentials. */
  server: string;
  network: string;
  authStrategy: string;
  scope: string;
  status: string;
  approved: boolean;
  tools: number;
  toolsDiscovered: number;
  calls24h: number;
  failureRate24h: number | null;
  p95LatencyMs: number | null;
  lastHealthStatus: string | null;
  lastHealthLatencyMs: number | null;
  lastHealthAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
}

export const DEGRADED_MCP_STATUSES = ['DEGRADED', 'DOWN', 'AUTH_REQUIRED'] as const;

export function serverLabel(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
    return `${u.host}${path}`;
  } catch {
    return 'invalid url';
  }
}

/**
 * MCP and tool connection health (design/03 table). Organization connections
 * only (shared connections and user-scope templates); personal connections are
 * counted, not listed. Tool latency/failure over 24 h via tool_calls_tool_idx.
 */
export async function mcpHealth(db: DbOrTx, now: Date): Promise<{ connections: McpHealthRow[]; personalConnections: number; definitions: Record<string, string> }> {
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const [connections, tools, calls, personal] = await Promise.all([
    db.execute<{
      id: string; name: string; description: string | null; url: string; network: string; auth_strategy: string; scope: string; status: string;
      approved_at: Date | null; last_health_status: string | null; last_health_latency_ms: number | null; last_health_at: Date | null; last_sync_at: Date | null; last_error: string | null;
    }>(sql`
      SELECT id, name, description, url, network, auth_strategy, scope, status, approved_at, last_health_status, last_health_latency_ms,
             last_health_at, last_sync_at, last_error
        FROM mcp_connections WHERE owner_user_id IS NULL ORDER BY name`),
    db.execute<{ connection_id: string; usable: number; discovered: number }>(sql`
      SELECT connection_id,
             count(*) FILTER (WHERE approved AND enabled AND removed_at IS NULL)::int AS usable,
             count(*) FILTER (WHERE removed_at IS NULL)::int AS discovered
        FROM tools WHERE connection_id IS NOT NULL GROUP BY connection_id`),
    db.execute<{ connection_id: string; n: number; failed: number; p95: number | null }>(sql`
      SELECT t.connection_id, count(*)::int AS n, count(*) FILTER (WHERE tc.status = 'FAILED')::int AS failed,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY tc.latency_ms) AS p95
        FROM tool_calls tc
        JOIN tools t ON t.id = tc.tool_id
       WHERE tc.tool_id IN (SELECT id FROM tools WHERE connection_id IS NOT NULL)
         AND tc.requested_at >= ${at(dayAgo)} AND tc.requested_at <= ${at(now)} AND tc.status IN ('SUCCEEDED', 'FAILED')
       GROUP BY t.connection_id`),
    db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM mcp_connections WHERE owner_user_id IS NOT NULL`),
  ]);
  const toolsBy = new Map(tools.rows.map((r) => [r.connection_id, r]));
  const callsBy = new Map(calls.rows.map((r) => [r.connection_id, r]));
  return {
    connections: connections.rows.map((c) => {
      const t = toolsBy.get(c.id);
      const k = callsBy.get(c.id);
      return {
        connectionId: c.id,
        name: c.name,
        description: c.description,
        server: serverLabel(c.url),
        network: c.network,
        authStrategy: c.auth_strategy,
        scope: c.scope,
        status: c.status,
        approved: c.approved_at !== null,
        tools: int(t?.usable),
        toolsDiscovered: int(t?.discovered),
        calls24h: int(k?.n),
        failureRate24h: ratio(int(k?.failed), int(k?.n)),
        p95LatencyMs: rounded(k?.p95),
        lastHealthStatus: c.last_health_status,
        lastHealthLatencyMs: c.last_health_latency_ms,
        lastHealthAt: iso(c.last_health_at),
        lastSyncAt: iso(c.last_sync_at),
        lastError: c.last_error,
      };
    }),
    personalConnections: int(personal.rows[0]?.n),
    definitions: {
      tools: 'Approved, enabled, not removed tools on the connection (toolsDiscovered includes unapproved ones).',
      p95LatencyMs: 'p95 of tool_calls.latency_ms over calls that finished (SUCCEEDED/FAILED) in the last 24 h.',
      failureRate24h: 'FAILED / (SUCCEEDED + FAILED) over the last 24 h.',
      degraded: `Connection status in ${DEGRADED_MCP_STATUSES.join(', ')}.`,
    },
  };
}
