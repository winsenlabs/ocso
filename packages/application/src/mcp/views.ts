import { inArray, sql } from 'drizzle-orm';
import { tools, type DbOrTx } from '@ocso/db';
import { isPersonal, isTemplate, type ConnectionRow, type ToolRow } from './records.js';

/** Where a connection is in the six-step "Add MCP server" flow (design/04). */
export type ConnectionStage = 'DISCOVER' | 'AUTHENTICATE' | 'REVIEW' | 'ACTIVE' | 'DISABLED';

export interface ToolCounts {
  total: number;
  approved: number;
  /** Changed on the server since approval and awaiting re-approval. */
  changed: number;
}

/**
 * Browser-safe connection view. Secret *references* are shown (the UI lists
 * them, design/04); secret values never leave the server.
 */
export interface ConnectionView {
  id: string;
  name: string;
  description: string | null;
  url: string;
  network: 'PUBLIC' | 'INTERNAL';
  scope: 'SHARED' | 'USER';
  kind: 'SHARED' | 'TEMPLATE' | 'PERSONAL';
  ownerUserId: string | null;
  templateId: string | null;
  status: ConnectionRow['status'];
  stage: ConnectionStage;
  auth: {
    strategy: ConnectionRow['authStrategy'];
    headerName: string | null;
    issuer: string | null;
    clientId: string | null;
    registration: string | null;
    tokenRef: string | null;
    clientInfoRef: string | null;
    scopes: string[];
  };
  /** Server-provided data (name, version, capabilities, sanitized instructions, auth metadata) — untrusted, render as text. */
  serverInfo: Record<string, unknown>;
  protocolVersion: string | null;
  confirmationPolicy: ConnectionRow['confirmationPolicy'];
  allowedAgentIds: '*' | string[];
  sendCustomerClaims: boolean;
  forwardUserToken: boolean;
  healthCheckSeconds: number;
  health: { status: string | null; latencyMs: number | null; checkedAt: string | null };
  lastSyncAt: string | null;
  lastError: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  tools: ToolCounts;
}

export interface ToolView {
  id: string;
  connectionId: string | null;
  name: string;
  modelName: string;
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  annotations: Record<string, unknown>;
  suggestedRisk: ToolRow['suggestedRisk'];
  riskClass: ToolRow['riskClass'];
  approved: boolean;
  enabled: boolean;
  humanRoles: string[];
  requiredScopes: string[];
  changedSinceApproval: boolean;
  discoveredAt: string;
  removedAt: string | null;
}

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function stageOf(row: ConnectionRow): ConnectionStage {
  if (row.status === 'DISABLED') return 'DISABLED';
  if (row.approvedAt) return 'ACTIVE';
  if (row.status === 'AUTH_REQUIRED') return 'AUTHENTICATE';
  return row.lastSyncAt ? 'REVIEW' : 'DISCOVER';
}

export function toConnectionView(row: ConnectionRow, counts: ToolCounts = { total: 0, approved: 0, changed: 0 }): ConnectionView {
  const cfg = row.authConfig;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    url: row.url,
    network: row.network,
    scope: row.scope,
    kind: isPersonal(row) ? 'PERSONAL' : isTemplate(row) ? 'TEMPLATE' : 'SHARED',
    ownerUserId: row.ownerUserId,
    templateId: row.templateId,
    status: row.status,
    stage: stageOf(row),
    auth: {
      strategy: row.authStrategy,
      headerName: str(cfg['headerName']),
      issuer: str(cfg['issuer']),
      clientId: str(cfg['clientId']),
      registration: str(cfg['registration']),
      tokenRef: row.tokenRef,
      clientInfoRef: row.clientInfoRef,
      scopes: row.grantedScopes,
    },
    serverInfo: row.serverInfo,
    protocolVersion: row.protocolVersion,
    confirmationPolicy: row.confirmationPolicy,
    allowedAgentIds: row.allowedAgentIds.includes('*') ? '*' : row.allowedAgentIds,
    sendCustomerClaims: row.sendCustomerClaims,
    forwardUserToken: row.forwardUserToken,
    healthCheckSeconds: row.healthCheckSeconds,
    health: { status: row.lastHealthStatus, latencyMs: row.lastHealthLatencyMs, checkedAt: iso(row.lastHealthAt) },
    lastSyncAt: iso(row.lastSyncAt),
    lastError: row.lastError,
    approvedBy: row.approvedBy,
    approvedAt: iso(row.approvedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    tools: counts,
  };
}

export function toToolView(row: ToolRow): ToolView {
  return {
    id: row.id,
    connectionId: row.connectionId,
    name: row.name,
    modelName: row.modelName,
    title: row.title,
    description: row.description,
    inputSchema: row.inputSchema,
    outputSchema: row.outputSchema,
    annotations: row.annotations,
    suggestedRisk: row.suggestedRisk,
    riskClass: row.riskClass,
    approved: row.approved,
    enabled: row.enabled,
    humanRoles: row.humanRoles,
    requiredScopes: row.requiredScopes,
    changedSinceApproval: row.changedSinceApproval,
    discoveredAt: row.discoveredAt.toISOString(),
    removedAt: iso(row.removedAt),
  };
}

/** Live (not removed) tool counts per connection. */
export async function loadToolCounts(db: DbOrTx, connectionIds: readonly string[]): Promise<Map<string, ToolCounts>> {
  const out = new Map<string, ToolCounts>();
  if (!connectionIds.length) return out;
  const rows = await db
    .select({
      connectionId: tools.connectionId,
      total: sql<number>`count(*) FILTER (WHERE ${tools.removedAt} IS NULL)::int`,
      approved: sql<number>`count(*) FILTER (WHERE ${tools.removedAt} IS NULL AND ${tools.approved})::int`,
      changed: sql<number>`count(*) FILTER (WHERE ${tools.removedAt} IS NULL AND ${tools.changedSinceApproval})::int`,
    })
    .from(tools)
    .where(inArray(tools.connectionId, [...connectionIds]))
    .groupBy(tools.connectionId);
  for (const r of rows) if (r.connectionId) out.set(r.connectionId, { total: r.total, approved: r.approved, changed: r.changed });
  return out;
}

export async function viewsOf(db: DbOrTx, rows: readonly ConnectionRow[]): Promise<ConnectionView[]> {
  const counts = await loadToolCounts(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toConnectionView(r, counts.get(r.id)));
}

export async function viewOf(db: DbOrTx, row: ConnectionRow): Promise<ConnectionView> {
  const [view] = await viewsOf(db, [row]);
  return view!;
}
