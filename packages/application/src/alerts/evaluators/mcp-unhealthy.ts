import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { defineEvaluator } from './contract.js';
import { observe, queryRows, textList } from './support.js';

const UNHEALTHY = ['DOWN', 'DEGRADED', 'AUTH_REQUIRED'] as const;

const Params = z
  .object({
    statuses: z.array(z.enum(UNHEALTHY)).min(1).default([...UNHEALTHY]),
    /** Personal (USER-scope) connections needing re-auth are normally the user's concern. */
    includePersonal: z.boolean().default(false),
  })
  .strict();

interface Row {
  id: string;
  name: string;
  status: string;
  scope: string;
  last_health_at: Date | null;
  last_health_latency_ms: number | null;
}

export const mcpUnhealthy = defineEvaluator({
  condition: 'mcp_unhealthy',
  label: 'MCP connection unhealthy',
  kinds: ['TECHNICAL'],
  agentScoped: true,
  method:
    'Current status of each MCP connection (maintained by the MCP health checker). Fires per connection whose status is in `statuses` (default DOWN, DEGRADED, AUTH_REQUIRED). Shared connections only unless `includePersonal`; agent-bound rules consider connections that agent may use.',
  params: Params,
  async evaluate(ctx) {
    const agentFilter = ctx.rule.agentId
      ? sql` AND (allowed_agent_ids @> ARRAY['*']::text[] OR allowed_agent_ids @> ARRAY[${ctx.rule.agentId}]::text[])`
      : sql``;
    const rows = await queryRows<Row>(
      ctx.db,
      sql`SELECT id::text AS id, name, status, scope, last_health_at, last_health_latency_ms
            FROM mcp_connections
           WHERE status IN (${textList(ctx.params.statuses)})
             ${ctx.params.includePersonal ? sql`` : sql` AND scope = 'SHARED'`}
             ${agentFilter}
           ORDER BY name`,
    );
    return rows.map((r) => {
      const status = r.status.toLowerCase().replace('_', ' ');
      const checked = r.last_health_at ? ` Last health check ${new Date(r.last_health_at).toISOString()}.` : '';
      return observe(ctx, { connectionId: r.id }, {
        firing: true,
        title: `MCP connection unhealthy · ${r.name}`,
        value: status,
        body: `MCP connection ${r.name} is ${status}; tools on this connection may fail or be unavailable to agents.${checked}`,
        source: `MCP · ${r.name}`,
        context: { connectionId: r.id, status: r.status, scope: r.scope, lastHealthLatencyMs: r.last_health_latency_ms },
      });
    });
  },
});
