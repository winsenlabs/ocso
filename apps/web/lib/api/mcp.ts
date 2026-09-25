import 'server-only';
import { z } from 'zod';
import { ObjectApprovalStateSchema, ProposedSchema } from '@/components/approvals/lib/schemas';
import { api } from './client';

/**
 * MCP connection manager (docs/archive/specs/08, ADR-021). Shapes mirror
 * packages/application/src/mcp/views.ts. Secret values never leave the API;
 * server-provided text (names, descriptions, instructions) is untrusted and
 * rendered as plain text only.
 */

export const CONNECTION_STATUSES = ['PENDING', 'AUTH_REQUIRED', 'ACTIVE', 'DEGRADED', 'DOWN', 'DISABLED'] as const;
export const RISK_CLASSES = ['READ', 'WRITE', 'SENSITIVE'] as const;
export const HUMAN_ROLES = ['SERVICE', 'LEAD', 'HEAD', 'TECH'] as const;
export const CONFIRMATION_POLICIES = ['SENSITIVE_ONLY', 'ALL_WRITES', 'NONE'] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];
export type HumanRole = (typeof HUMAN_ROLES)[number];
export type ConfirmationPolicy = (typeof CONFIRMATION_POLICIES)[number];

const text = z.string().nullable();

export const ConnectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: text,
  url: z.string(),
  network: z.enum(['PUBLIC', 'INTERNAL']),
  scope: z.enum(['SHARED', 'USER']),
  kind: z.enum(['SHARED', 'TEMPLATE', 'PERSONAL']),
  ownerUserId: text,
  templateId: text,
  status: z.enum(CONNECTION_STATUSES),
  stage: z.enum(['DISCOVER', 'AUTHENTICATE', 'REVIEW', 'ACTIVE', 'DISABLED']),
  auth: z.object({
    strategy: z.enum(['NONE', 'HEADER', 'OAUTH']),
    headerName: text,
    issuer: text,
    clientId: text,
    registration: text,
    tokenRef: text,
    clientInfoRef: text,
    scopes: z.array(z.string()),
  }),
  serverInfo: z.record(z.string(), z.unknown()),
  protocolVersion: text,
  confirmationPolicy: z.enum(CONFIRMATION_POLICIES),
  allowedAgentIds: z.union([z.literal('*'), z.array(z.string())]),
  sendCustomerClaims: z.boolean(),
  forwardUserToken: z.boolean().default(false),
  healthCheckSeconds: z.number(),
  health: z.object({ status: text, latencyMs: z.number().nullable(), checkedAt: text }),
  lastSyncAt: text,
  lastError: text,
  approvedBy: text,
  approvedAt: text,
  createdAt: z.string(),
  updatedAt: z.string(),
  tools: z.object({ total: z.number(), approved: z.number(), changed: z.number() }),
  /** Maker–checker state (PM/research/11 §4); absent for personal connections. */
  approval: ObjectApprovalStateSchema.nullable().catch(null).default(null),
});
export type Connection = z.infer<typeof ConnectionSchema>;

export const ToolSchema = z.object({
  id: z.string(),
  name: z.string(),
  modelName: z.string(),
  title: text,
  description: z.string(),
  annotations: z.record(z.string(), z.unknown()),
  suggestedRisk: z.enum(RISK_CLASSES),
  riskClass: z.enum(RISK_CLASSES),
  approved: z.boolean(),
  enabled: z.boolean(),
  humanRoles: z.array(z.string()),
  requiredScopes: z.array(z.string()),
  changedSinceApproval: z.boolean(),
  discoveredAt: z.string(),
  removedAt: text,
});
export type Tool = z.infer<typeof ToolSchema>;

export const AuthRequiredSchema = z.object({
  reason: z.string(),
  resourceMetadataUrl: text,
  resource: text,
  authorizationServers: z.array(z.string()),
  scopesSupported: z.array(z.string()),
  challengedScope: text,
  oauthAvailable: z.boolean(),
});
export type AuthRequired = z.infer<typeof AuthRequiredSchema>;

const SyncSummarySchema = z.object({
  total: z.number(),
  added: z.number(),
  changed: z.number(),
  removed: z.number(),
  restored: z.number(),
  needsReapproval: z.array(z.string()),
});

export const DiscoverySchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('DISCOVERED'), connection: ConnectionSchema, tools: SyncSummarySchema, warnings: z.array(z.string()) }),
  z.object({ outcome: z.literal('AUTH_REQUIRED'), connection: ConnectionSchema, authRequired: AuthRequiredSchema }),
]);
export type Discovery = z.infer<typeof DiscoverySchema>;

const OAuthBegunSchema = z.object({ authorizationUrl: z.string(), expiresAt: z.string() });
const HealthOutcomeSchema = z.object({
  health: z.string(),
  previousStatus: z.string(),
  status: z.string(),
  changed: z.boolean(),
  latencyMs: z.number().nullable(),
  detail: z.string(),
});
export type HealthOutcome = z.infer<typeof HealthOutcomeSchema>;

export const HealthSampleSchema = z.object({ status: z.string(), latencyMs: z.number().nullable(), detail: text, sampledAt: z.string() });
export type HealthSample = z.infer<typeof HealthSampleSchema>;

const AgentLiteSchema = z.object({ id: z.string(), name: z.string() });
export type AgentLite = z.infer<typeof AgentLiteSchema>;

export interface CreateConnection {
  name: string;
  description?: string;
  url: string;
  network: 'PUBLIC' | 'INTERNAL';
  scope: 'SHARED' | 'USER';
}
export interface BeginOAuth {
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
}
export interface ToolClassification {
  toolId: string;
  riskClass: RiskClass;
  approved: boolean;
  humanRoles?: HumanRole[];
}
export interface Approval {
  allowedAgentIds: '*' | string[];
  confirmationPolicy: ConfirmationPolicy;
  sendCustomerClaims: boolean;
  forwardUserToken?: boolean | undefined;
  healthCheckSeconds: number;
}

/** Base path: shared connections and templates, or the caller's personal connections. */
export type McpArea = 'connections' | 'personal';
const base = (area: McpArea, id: string) => `/v1/mcp/${area}/${id}`;
/** Discovery and OAuth talk to the MCP server: allow for its own timeouts. */
const SLOW = { timeoutMs: 45_000 };

export const listConnections = () => api.get('/v1/mcp/connections', z.array(ConnectionSchema));
export const getConnection = (id: string, area: McpArea = 'connections') => api.get(base(area, id), ConnectionSchema);
export const listTools = (id: string, options: { area?: McpArea; includeRemoved?: boolean } = {}) =>
  api.get(`${base(options.area ?? 'connections', id)}/tools${options.includeRemoved ? '?includeRemoved=true' : ''}`, z.array(ToolSchema));
export const healthHistory = (id: string, limit = 60) => api.get(`/v1/mcp/connections/${id}/health?limit=${limit}`, z.array(HealthSampleSchema));

export const createConnection = (input: CreateConnection) => api.post('/v1/mcp/connections', input, ConnectionSchema);
export const discover = (id: string, area: McpArea = 'connections') => api.post(`${base(area, id)}/discover`, undefined, DiscoverySchema, SLOW);
export const rediscover = (id: string) => api.post(`/v1/mcp/connections/${id}/rediscover`, undefined, DiscoverySchema, SLOW);
export const setHeaderAuth = (id: string, input: { headerName: string; token: string }, area: McpArea = 'connections') =>
  api.post(`${base(area, id)}/auth/header`, input, DiscoverySchema, SLOW);
export const beginOAuth = (id: string, input: BeginOAuth, area: McpArea = 'connections') => api.post(`${base(area, id)}/oauth/begin`, input, OAuthBegunSchema, SLOW);
type ApprovalChoice = { checkerId: string; reason: string } | { bootstrap: true; reason?: string | undefined };
/** A draft's tools change directly; an approved connection's answer 409 approval_required until `approval` names a checker (202). */
export const classifyTools = (id: string, tools: ToolClassification[], approval?: ApprovalChoice) =>
  api.put(`/v1/mcp/connections/${id}/tools`, { tools, ...(approval ? { approval } : {}) }, z.union([z.array(ToolSchema), ProposedSchema]));
/** A draft: records the agent policy, then its activation is a proposal (409 without `approval`, 202 with). */
export const approveConnection = (id: string, input: Approval & { approval?: ApprovalChoice | undefined }) => api.post(`/v1/mcp/connections/${id}/approve`, input, z.union([ConnectionSchema, ProposedSchema]));
export const disableConnection = (id: string) => api.post(`/v1/mcp/connections/${id}/disable`, undefined, ConnectionSchema);
export const enableConnection = (id: string) => api.post(`/v1/mcp/connections/${id}/enable`, undefined, ConnectionSchema);
export const deleteConnection = (id: string, area: McpArea = 'connections') => api.command('DELETE', base(area, id));
export const checkHealth = (id: string, area: McpArea = 'connections') => api.post(`${base(area, id)}/health`, undefined, HealthOutcomeSchema, SLOW);

export const listTemplates = () => api.get('/v1/mcp/personal/templates', z.array(ConnectionSchema));
export const listMyConnections = () => api.get('/v1/mcp/personal', z.array(ConnectionSchema));
export const createPersonalConnection = (templateId: string) => api.post('/v1/mcp/personal', { templateId }, ConnectionSchema);

/** Agents that can be allowed to use a shared connection (GET /v1/agents, agents.read). */
export const listAgentsLite = () => api.get('/v1/agents', z.array(AgentLiteSchema));
