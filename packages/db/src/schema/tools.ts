import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './columns.js';
import { users } from './identity.js';

/** MCP server connection (docs/08 §2). Tokens are secret references only. */
export const mcpConnections = pgTable(
  'mcp_connections',
  {
    id: id(),
    name: text().notNull(),
    description: text(),
    url: text().notNull(),
    network: text().$type<'PUBLIC' | 'INTERNAL'>().notNull().default('PUBLIC'),
    scope: text().$type<'SHARED' | 'USER'>().notNull().default('SHARED'),
    ownerUserId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    /** For USER-scope templates: the shared definition personal connections derive from. */
    templateId: uuid(),
    authStrategy: text().$type<'NONE' | 'HEADER' | 'OAUTH'>().notNull().default('NONE'),
    authConfig: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    tokenRef: text(),
    clientInfoRef: text(),
    status: text()
      .$type<'PENDING' | 'AUTH_REQUIRED' | 'ACTIVE' | 'DEGRADED' | 'DOWN' | 'DISABLED'>()
      .notNull()
      .default('PENDING'),
    serverInfo: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    protocolVersion: text(),
    confirmationPolicy: text().$type<'SENSITIVE_ONLY' | 'ALL_WRITES' | 'NONE'>().notNull().default('SENSITIVE_ONLY'),
    /** `["*"]` = any agent the CS Lead enables; otherwise explicit agent ids. */
    allowedAgentIds: text().array().notNull().default(sql`'{}'::text[]`),
    grantedScopes: text().array().notNull().default(sql`'{}'::text[]`),
    sendCustomerClaims: boolean().notNull().default(false),
    healthCheckSeconds: integer().notNull().default(60),
    lastSyncAt: ts('last_sync_at'),
    lastHealthAt: ts('last_health_at'),
    lastHealthStatus: text(),
    lastHealthLatencyMs: integer(),
    lastError: text(),
    createdBy: uuid().references(() => users.id),
    approvedBy: uuid().references(() => users.id),
    approvedAt: ts('approved_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('mcp_connections_name_uq').on(sql`lower(${t.name})`, sql`coalesce(${t.ownerUserId}::text, '')`),
  ],
);

/** Pending OAuth authorization (PKCE verifier etc. held in the secret store). */
export const mcpOauthPending = pgTable('mcp_oauth_pending', {
  stateHash: text().primaryKey(),
  connectionId: uuid()
    .notNull()
    .references(() => mcpConnections.id, { onDelete: 'cascade' }),
  userId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  pendingRef: text().notNull(),
  expiresAt: ts('expires_at').notNull(),
  createdAt: createdAt(),
});

/** Discovered/approved tools; built-in OCSO tools have no connection. */
export const tools = pgTable(
  'tools',
  {
    id: id(),
    connectionId: uuid().references(() => mcpConnections.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    modelName: text().notNull(),
    title: text(),
    description: text().notNull().default(''),
    inputSchema: jsonb().$type<Record<string, unknown>>().notNull(),
    outputSchema: jsonb().$type<Record<string, unknown>>(),
    annotations: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    schemaHash: text().notNull(),
    suggestedRisk: text().$type<'READ' | 'WRITE' | 'SENSITIVE'>().notNull(),
    riskClass: text().$type<'READ' | 'WRITE' | 'SENSITIVE'>().notNull(),
    approved: boolean().notNull().default(false),
    enabled: boolean().notNull().default(true),
    requiredScopes: text().array().notNull().default(sql`'{}'::text[]`),
    humanRoles: text().array().notNull().default(sql`'{CS_EXEC,CS_LEAD}'::text[]`),
    changedSinceApproval: boolean().notNull().default(false),
    discoveredAt: ts('discovered_at').notNull().defaultNow(),
    removedAt: ts('removed_at'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('tools_connection_name_uq').on(sql`coalesce(${t.connectionId}::text, 'builtin')`, t.name),
    uniqueIndex('tools_model_name_uq').on(t.modelName),
  ],
);

/** Auditable tool invocation (docs/03 ToolCall, docs/08 §8). Arguments are sanitized. */
export const toolCalls = pgTable(
  'tool_calls',
  {
    id: id(),
    conversationId: uuid(),
    turnId: uuid(),
    toolId: uuid(),
    toolName: text().notNull(),
    connectionId: uuid(),
    actorType: text().$type<'AGENT' | 'HUMAN' | 'INTERNAL_AGENT'>().notNull(),
    actorId: text().notNull(),
    onBehalfOfUserId: uuid(),
    modelToolCallId: text(),
    argsSanitized: jsonb().notNull(),
    argsHash: text().notNull(),
    status: text()
      .$type<'REQUESTED' | 'AWAITING_CONFIRMATION' | 'DENIED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED'>()
      .notNull(),
    decisionCode: text(),
    decisionReason: text(),
    confirmationReason: text(),
    confirmedBy: uuid(),
    confirmedAt: ts('confirmed_at'),
    confirmationExpiresAt: ts('confirmation_expires_at'),
    idempotencyKey: text(),
    resultSummary: jsonb(),
    errorCategory: text(),
    errorMessage: text(),
    latencyMs: integer(),
    externalCorrelationId: text(),
    traceId: text(),
    requestedAt: ts('requested_at').notNull().defaultNow(),
    completedAt: ts('completed_at'),
  },
  (t) => [
    index('tool_calls_conversation_idx').on(t.conversationId, t.requestedAt),
    index('tool_calls_status_idx').on(t.status, t.requestedAt),
    index('tool_calls_tool_idx').on(t.toolId, t.requestedAt),
  ],
);

export const mcpHealthSamples = pgTable(
  'mcp_health_samples',
  {
    id: uuid().primaryKey(),
    connectionId: uuid()
      .notNull()
      .references(() => mcpConnections.id, { onDelete: 'cascade' }),
    status: text().notNull(),
    latencyMs: integer(),
    detail: text(),
    sampledAt: ts('sampled_at').notNull().defaultNow(),
  },
  (t) => [index('mcp_health_samples_idx').on(t.connectionId, t.sampledAt)],
);
