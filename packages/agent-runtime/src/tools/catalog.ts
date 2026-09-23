import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { ToolSpec } from '@ocso/domain';
import { agentToolGrants, mcpConnections, tools, type DbOrTx } from '@ocso/db';
import { sanitizeToolDescription, type AgentToolGrant, type ConnectionRecord, type FirstPartyTool, type ToolRecord } from '@ocso/tools';
import { BUILTIN_TOOLS } from './builtins.js';
import { CONVERSATION_SCOPED_TOOLS } from './transfer-tool.js';

export interface CatalogEntry {
  tool: ToolRecord;
  connection: ConnectionRecord | null;
  grant: AgentToolGrant | null;
  /** Name on the provider (the MCP server's name; the model-facing name for first-party tools). */
  serverName: string;
  /** Trusted connection: calls carry short-lived customer identity claims (docs/08 §4). */
  sendCustomerClaims: boolean;
  /** The connection receives the customer's verified user token (web chat tool identity passthrough). */
  forwardUserToken: boolean;
  /** The `tools` row (MCP tools); null for first-party tools, which are code rather than records. */
  recordId: string | null;
}

export interface AgentToolCatalog {
  specs: ToolSpec[];
  entries: Map<string, CatalogEntry>;
}

/**
 * First-party tools are available to every agent: approved and enabled by
 * definition, granted with no argument rules and no forced confirmation.
 * They still pass authorizeToolCall (conversation state, JSON Schema, risk).
 */
function firstPartyEntry(tool: FirstPartyTool, agentId: string): CatalogEntry {
  return {
    tool: {
      id: tool.name,
      connectionId: null,
      modelName: tool.name,
      displayName: tool.name,
      riskClass: tool.riskClass,
      approved: true,
      enabled: true,
      inputSchema: tool.inputSchema,
      requiredScopes: [],
      humanRoles: [],
    },
    connection: null,
    grant: { agentId, toolId: tool.name, enabled: true, alwaysConfirm: false, argumentRules: [] },
    serverName: tool.name,
    sendCustomerClaims: false,
    forwardUserToken: false,
    recordId: null,
  };
}

/**
 * Effective tools for a virtual agent (docs/08 §3): first-party tools (the
 * built-ins unless the registry's list is passed) plus approved, enabled
 * tools on usable SHARED connections that the connection allows for this
 * agent AND the Lead granted to this agent. Personal (USER) connections
 * are never exposed to agents. An MCP tool can never shadow a first-party name.
 */
export async function loadAgentToolCatalog(db: DbOrTx, agentId: string, firstParty: readonly FirstPartyTool[] = BUILTIN_TOOLS): Promise<AgentToolCatalog> {
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
  const specs: ToolSpec[] = [];
  for (const tool of firstParty) {
    if (CONVERSATION_SCOPED_TOOLS.has(tool.name)) continue;
    entries.set(tool.name, firstPartyEntry(tool, agentId));
    specs.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
  }
  for (const { t, c, g } of rows) {
    if (entries.has(t.modelName)) continue;
    entries.set(t.modelName, {
      serverName: t.name,
      sendCustomerClaims: c.sendCustomerClaims,
      forwardUserToken: c.forwardUserToken,
      recordId: t.id,
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

/** The agent's catalog plus a first-party tool shaped for this conversation (e.g. the transfer tool's queue enum). */
export function withConversationTool(catalog: AgentToolCatalog, tool: FirstPartyTool, agentId: string): AgentToolCatalog {
  const entries = new Map(catalog.entries);
  entries.set(tool.name, firstPartyEntry(tool, agentId));
  return { entries, specs: [...catalog.specs.filter((s) => s.name !== tool.name), { name: tool.name, description: tool.description, inputSchema: tool.inputSchema }] };
}
