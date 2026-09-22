import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { ToolSpec } from '@ocso/domain';
import { agentToolGrants, mcpConnections, tools, type DbOrTx } from '@ocso/db';
import { sanitizeToolDescription, type AgentToolGrant, type ConnectionRecord, type ToolRecord } from '@ocso/tools';
import { BUILTIN_TOOL_SPECS } from './builtins.js';

export interface CatalogEntry {
  tool: ToolRecord;
  connection: ConnectionRecord | null;
  grant: AgentToolGrant | null;
  /** Name on the MCP server (differs from the model-facing name). */
  serverName: string;
  /** Trusted connection: calls carry short-lived customer identity claims (docs/08 §4). */
  sendCustomerClaims: boolean;
}

export interface AgentToolCatalog {
  specs: ToolSpec[];
  entries: Map<string, CatalogEntry>;
}

/**
 * Effective tools for a virtual agent (docs/08 §3): built-ins plus approved,
 * enabled tools on usable SHARED connections that the connection allows for
 * this agent AND the CS Lead granted to this agent. Personal (USER) connections
 * are never exposed to agents.
 */
export async function loadAgentToolCatalog(db: DbOrTx, agentId: string): Promise<AgentToolCatalog> {
  const rows = await db
    .select({ t: tools, c: mcpConnections, g: agentToolGrants })
    .from(tools)
    .innerJoin(agentToolGrants, and(eq(agentToolGrants.toolId, tools.id), eq(agentToolGrants.agentId, agentId), eq(agentToolGrants.enabled, true)))
    .innerJoin(mcpConnections, eq(mcpConnections.id, tools.connectionId))
    .where(
      and(
        eq(tools.approved, true),
        eq(tools.enabled, true),
        isNull(tools.removedAt),
        eq(mcpConnections.scope, 'SHARED'),
        inArray(mcpConnections.status, ['ACTIVE', 'DEGRADED']),
        sql`(${mcpConnections.allowedAgentIds} @> ARRAY['*']::text[] OR ${mcpConnections.allowedAgentIds} @> ARRAY[${agentId}]::text[])`,
      ),
    );

  const entries = new Map<string, CatalogEntry>();
  const specs: ToolSpec[] = [...BUILTIN_TOOL_SPECS];
  for (const { t, c, g } of rows) {
    entries.set(t.modelName, {
      serverName: t.name,
      sendCustomerClaims: c.sendCustomerClaims,
      tool: {
        id: t.id,
        connectionId: t.connectionId,
        modelName: t.modelName,
        displayName: t.title ?? t.name,
        riskClass: t.riskClass,
        approved: t.approved,
        enabled: t.enabled,
        inputSchema: t.inputSchema,
        requiredScopes: t.requiredScopes,
        humanRoles: t.humanRoles,
      },
      connection: {
        id: c.id,
        name: c.name,
        status: c.status,
        scope: c.scope,
        ownerUserId: c.ownerUserId,
        allowedAgentIds: c.allowedAgentIds.includes('*') ? 'ALL' : c.allowedAgentIds,
        grantedScopes: c.grantedScopes,
        confirmationPolicy: c.confirmationPolicy,
      },
      grant: { agentId, toolId: t.id, enabled: g.enabled, alwaysConfirm: g.alwaysConfirm, argumentRules: g.argumentRules },
    });
    specs.push({
      name: t.modelName,
      description: `${sanitizeToolDescription(t.description)}${t.riskClass === 'SENSITIVE' ? ' (sensitive: may require human confirmation)' : ''}`,
      inputSchema: t.inputSchema,
    });
  }
  return { specs, entries };
}
