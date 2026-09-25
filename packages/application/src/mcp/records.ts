import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { notFound } from '@ocso/domain';
import { agentToolGrants, mcpConnections, tools, type Db, type DbOrTx } from '@ocso/db';
import { sha256Hex, type DnsResolver, type EgressLimits, type HealthOptions, type McpAuthConfig, type McpConnectionTarget } from '@ocso/mcp';
import type { SecretStore } from '@ocso/secrets';
import { bumpGeneration } from '../cache/generations.js';

export type ConnectionRow = typeof mcpConnections.$inferSelect;
export type ToolRow = typeof tools.$inferSelect;
export type ConnectionStatus = ConnectionRow['status'];

/** Dependencies shared by every MCP connection-manager collaborator. */
export interface McpContext {
  db: Db;
  secrets: SecretStore;
  now: () => Date;
  /** OAuth redirect URI: `${OCSO_PUBLIC_URL}/oauth/mcp/callback`. */
  redirectUri: string;
  resolver?: DnsResolver | undefined;
  limits?: Partial<EgressLimits> | undefined;
  discoveryTimeoutMs?: number | undefined;
  health?: HealthOptions | undefined;
  oauthPendingTtlMs?: number | undefined;
}

/** Statuses in which the runtime catalogue exposes a connection's tools (see agent-runtime catalog.ts). */
export const USABLE_STATUSES: ReadonlySet<ConnectionStatus> = new Set(['ACTIVE', 'DEGRADED']);

export async function loadConnection(db: DbOrTx, id: string, options: { lock?: boolean } = {}): Promise<ConnectionRow> {
  const query = db.select().from(mcpConnections).where(eq(mcpConnections.id, id));
  const [row] = options.lock ? await query.for('update') : await query;
  if (!row) throw notFound('mcp_connection', id);
  return row;
}

/** A personal connection: one user's instance of a USER-scope template. */
export const isPersonal = (row: Pick<ConnectionRow, 'ownerUserId'>): boolean => row.ownerUserId !== null;

/** An admin-published USER-scope definition that personal connections derive from. */
export const isTemplate = (row: Pick<ConnectionRow, 'scope' | 'ownerUserId'>): boolean => row.scope === 'USER' && row.ownerUserId === null;

/**
 * Prefix of model-facing tool names (`tools.modelName` is globally unique).
 * Shared names are unique slugs without `_`; personal instances add an `_u`
 * suffix derived from their id so two users' copies never collide.
 */
export function modelPrefix(row: Pick<ConnectionRow, 'id' | 'name' | 'ownerUserId'>): string {
  return isPersonal(row) ? `${row.name}_u${sha256Hex(row.id).slice(0, 8)}` : row.name;
}

interface StoredAuthConfig {
  headerName?: string;
  issuer?: string;
  clientId?: string;
}

export function authConfigOf(row: ConnectionRow): McpAuthConfig {
  const cfg = row.authConfig as StoredAuthConfig;
  if (row.authStrategy === 'HEADER' && row.tokenRef && cfg.headerName) {
    return { strategy: 'HEADER', headerName: cfg.headerName, tokenRef: row.tokenRef };
  }
  if (row.authStrategy === 'OAUTH' && row.tokenRef && cfg.issuer && cfg.clientId) {
    return {
      strategy: 'OAUTH',
      tokenRef: row.tokenRef,
      issuer: cfg.issuer,
      clientId: cfg.clientId,
      clientInfoRef: row.clientInfoRef ?? undefined,
      scopes: row.grantedScopes,
    };
  }
  return { strategy: 'NONE' };
}

/** Plain config for @ocso/mcp; secrets stay references. */
export function connectionTarget(row: ConnectionRow): McpConnectionTarget {
  return { id: row.id, name: modelPrefix(row), url: row.url, network: row.network, auth: authConfigOf(row) };
}

/** Agents whose runtime tool catalogue can change with this connection: grant holders plus explicitly named agents. */
export async function affectedAgentIds(db: DbOrTx, connectionIds: readonly string[], extra: readonly string[] = []): Promise<string[]> {
  const ids = new Set(extra.filter((id) => id !== '*'));
  if (connectionIds.length) {
    const rows = await db
      .selectDistinct({ agentId: agentToolGrants.agentId })
      .from(agentToolGrants)
      .innerJoin(tools, eq(tools.id, agentToolGrants.toolId))
      .where(and(isNotNull(tools.connectionId), inArray(tools.connectionId, [...connectionIds])));
    for (const r of rows) ids.add(r.agentId);
  }
  return [...ids].sort();
}

/** Invalidate the cached tool catalogues of these agents (docs/archive/specs/05 §5). */
export async function bumpAgents(tx: DbOrTx, correlationId: string, agentIds: readonly string[]): Promise<void> {
  for (const id of agentIds) await bumpGeneration(tx, correlationId, `agent:${id}`, 'tools_changed');
}

/** Postgres unique_violation, possibly wrapped by the driver/ORM. */
export function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && typeof e === 'object' && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === '23505') return true;
  }
  return false;
}

/** Delete secrets after the rows referencing them are gone; failures only leave an orphan, never a dangling ref. */
export async function revokeSecrets(secrets: SecretStore, refs: ReadonlyArray<string | null | undefined>): Promise<void> {
  for (const ref of new Set(refs)) {
    if (ref) await secrets.delete(ref).catch(() => undefined);
  }
}
