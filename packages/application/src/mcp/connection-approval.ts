import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { Permission } from '@ocso/auth';
import { mcpConnections, tools, virtualAgents, type Db, type DbOrTx } from '@ocso/db';
import { DomainError, ErrorCategory, isDomainError, notFound, validation } from '@ocso/domain';
import { McpAuthRequiredError, McpDiscoveryService, type DnsResolver, type EgressLimits } from '@ocso/mcp';
import type { SecretStore } from '@ocso/secrets';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import type { ApprovalDescriptor, ApprovalProblem, ProposalRow } from '../approvals/contract.js';
import { platformRequiresApproval, platformTitle, platformVisible } from '../settings/platform-approvals.js';
import { claimSecrets, releaseSecrets, unstagedRefProblems } from '../settings/secret-refs.js';
import type { ActorContext } from '../shared/context.js';
import { deleteConnectionRows, policyProblems, readinessProblems, writeConnectionPolicy, writeToolClassification } from './connection-apply.js';
import { SecretCredentialPort } from './credentials.js';
import { loadEgressPolicy } from './egress.js';
import { ApproveConnectionInput, ClassifyToolsInput, HeaderAuthInput } from './inputs.js';
import { affectedAgentIds, bumpAgents, connectionTarget, isPersonal, type ConnectionRow } from './records.js';

/**
 * Shared MCP connections and user-scope templates under maker–checker (PM/research/11 §4,
 * approvals.check.platform). Personal connections are one user's credentials and are never proposals.
 * - A connection never approved is a draft (PENDING): discover, authenticate, classify tools and set the
 *   agent policy directly; the runtime never exposes it.
 * - ACTIVATE takes it live (and resumes a disabled one). It is DEFERRED: the worker re-contacts the server
 *   and refuses (BLOCKED) when the tool set changed since the checker reviewed it — re-validation where it
 *   needs the network.
 * - UPDATE: tool approvals, the agent policy, or a new header credential (stored as a new secret at submit).
 * - DELETE: always a proposal. Disabling is a stop action (immediate, never gated).
 */

export const ConnectionChange = z
  .object({
    policy: ApproveConnectionInput.optional(),
    tools: ClassifyToolsInput.shape.tools.optional(),
    headerCredential: z.object({ headerName: HeaderAuthInput.shape.headerName, ref: z.string().min(1).max(300) }).strict().optional(),
  })
  .strict()
  .refine((c) => c.policy || c.tools || c.headerCredential, 'Change the policy, the tools or the header credential');
export type ConnectionChange = z.output<typeof ConnectionChange>;

export interface ConnectionApprovalDeps {
  secrets?: SecretStore | undefined;
  resolver?: DnsResolver | undefined;
  limits?: Partial<EgressLimits> | undefined;
  discoveryTimeoutMs?: number | undefined;
}

async function load(tx: DbOrTx, id: string): Promise<ConnectionRow | null> {
  const [row] = await tx.select().from(mcpConnections).where(eq(mcpConnections.id, id));
  return row ?? null;
}

type ToolLine = { id: string; name: string; riskClass: string; approved: boolean; humanRoles: string[]; schemaHash: string };

async function toolLines(tx: DbOrTx, id: string): Promise<ToolLine[]> {
  return tx
    .select({ id: tools.id, name: tools.name, riskClass: tools.riskClass, approved: tools.approved, humanRoles: tools.humanRoles, schemaHash: tools.schemaHash })
    .from(tools)
    .where(and(eq(tools.connectionId, id), isNull(tools.removedAt)))
    .orderBy(asc(tools.name));
}

async function project(tx: DbOrTx, row: ConnectionRow, change?: ConnectionChange): Promise<Record<string, unknown>> {
  const policy = change?.policy;
  const allowed = policy ? (policy.allowedAgentIds === '*' ? ['*'] : policy.allowedAgentIds) : row.allowedAgentIds;
  const explicit = allowed.filter((a) => a !== '*');
  const agents = explicit.length ? await tx.select({ id: virtualAgents.id, name: virtualAgents.name }).from(virtualAgents).where(inArray(virtualAgents.id, explicit)) : [];
  const classified = new Map((change?.tools ?? []).map((t) => [t.toolId, t]));
  const header = change?.headerCredential;
  return {
    name: row.name,
    description: row.description,
    url: row.url,
    network: row.network,
    scope: row.scope,
    status: row.status,
    authentication: header ? `HEADER ${header.headerName}` : row.authStrategy === 'HEADER' ? `HEADER ${String((row.authConfig as { headerName?: string }).headerName ?? '')}` : row.authStrategy,
    credential: header ? 'new value (proposed)' : row.tokenRef ? 'stored' : 'none',
    agents: allowed.includes('*') ? 'any enabled agent' : explicit.map((id) => agents.find((a) => a.id === id)?.name ?? `missing (${id.slice(0, 8)})`).sort(),
    confirmationPolicy: policy?.confirmationPolicy ?? row.confirmationPolicy,
    sendCustomerClaims: policy?.sendCustomerClaims ?? row.sendCustomerClaims,
    healthCheckSeconds: policy?.healthCheckSeconds ?? row.healthCheckSeconds,
    toolSetHash: (row.serverInfo as { toolSetHash?: string }).toolSetHash ?? null,
    tools: (await toolLines(tx, row.id)).map((t) => {
      const c = classified.get(t.id);
      return { name: t.name, riskClass: c?.riskClass ?? t.riskClass, approved: c?.approved ?? t.approved, humanRoles: c?.humanRoles ?? t.humanRoles, schemaHash: t.schemaHash };
    }),
  };
}

/** The server's tools now, compared with the tool set the checker reviewed (outside any transaction: network). */
async function probeToolSet(deps: ConnectionApprovalDeps, db: Db, row: ConnectionRow, reviewed: string | null): Promise<void> {
  if (!reviewed) throw validation('mcp_tools_unreviewed', 'The reviewed change has no tool set on record; rediscover, review and submit again.');
  if (!deps.secrets) throw validation('mcp_activation_unavailable', 'MCP activation cannot reach the server from this process');
  const service = new McpDiscoveryService({ credentials: new SecretCredentialPort(db, deps.secrets), egress: await loadEgressPolicy(db, row.network), resolver: deps.resolver, limits: deps.limits });
  let hash: string;
  try {
    hash = (await service.discover(connectionTarget(row), { timeoutMs: deps.discoveryTimeoutMs })).toolSetHash;
  } catch (err) {
    if (err instanceof McpAuthRequiredError) throw validation('mcp_auth_required', 'The server now requires authentication; authenticate and submit again.');
    if (isDomainError(err) && !err.retriable) throw err;
    throw new DomainError(ErrorCategory.TOOL_UNAVAILABLE, 'mcp_unreachable', 'The MCP server could not be reached; activation will be retried.');
  }
  if (hash !== reviewed) throw validation('mcp_tools_changed', 'The server’s tools changed since they were reviewed; rediscover, review and submit again.');
}

async function applyChange(tx: DbOrTx, actor: ActorContext, row: ConnectionRow, change: ConnectionChange, deps: ConnectionApprovalDeps): Promise<void> {
  const now = new Date();
  if (change.tools) await writeToolClassification(tx, actor, row, change.tools, now);
  if (change.policy) await writeConnectionPolicy(tx, actor, row, ApproveConnectionInput.parse(change.policy), { now });
  if (change.headerCredential) {
    const { headerName, ref } = change.headerCredential;
    await tx
      .update(mcpConnections)
      .set({ authStrategy: 'HEADER', authConfig: { headerName }, tokenRef: ref, clientInfoRef: null, grantedScopes: [], lastError: null, lastHealthAt: null, updatedAt: now })
      .where(eq(mcpConnections.id, row.id));
    await recordAudit(tx, actor, {
      action: 'mcp.connection.auth_header',
      targetType: 'mcp_connection',
      targetId: row.id,
      summary: `Set ${headerName} header credential on ${row.name}`,
      before: { strategy: row.authStrategy, credentialRef: row.tokenRef, clientInfoRef: row.clientInfoRef },
      after: { headerName, credentialRef: ref },
    });
    await bumpAgents(tx, actor.correlationId, await affectedAgentIds(tx, [row.id], row.allowedAgentIds));
    await emitEvent(tx, actor, 'config.changed', { area: 'mcp', entityId: row.id });
    await claimSecrets(tx, [ref]);
    await releaseSecrets(tx, { kind: 'mcp_connection', objectId: row.id }, [row.tokenRef, row.clientInfoRef].filter((r) => r !== ref));
  }
}

/** Stopped (disabled) after the ACTIVATE was submitted: approving it must never undo that stop. */
function stoppedSinceSubmit(row: ConnectionRow, p: ProposalRow): boolean {
  return row.status === 'DISABLED' && (p.beforeSnapshot as { status?: string } | null)?.status !== 'DISABLED';
}

/**
 * The approved ACTIVATE already committed (activateDeferred ran; the spine's stamp may not have). Nothing else
 * sets approvedAt while this proposal locks the connection, so a go-live stamped after its submit is its own.
 */
function activationCommitted(row: ConnectionRow | null, p: ProposalRow): boolean {
  return Boolean(p.status === 'APPROVED' && row?.approvedAt && row.approvedAt.getTime() >= p.submittedAt.getTime() && row.approvedBy === p.decidedBy);
}

export function connectionApproval(deps: ConnectionApprovalDeps = {}): ApprovalDescriptor {
  const visible = platformVisible(Permission.MCP_READ);
  return {
    kind: 'mcp_connection',
    label: 'MCP connection',
    actions: ['ACTIVATE', 'UPDATE', 'DELETE'],
    makePermission: () => Permission.MCP_MANAGE,
    checkPermission: Permission.APPROVALS_CHECK_PLATFORM,
    payload: ConnectionChange,
    // Health checks move the status (ACTIVE / DEGRADED / DOWN) and disabling is a stop action.
    hashExclude: ['status'],

    async project(tx, id) {
      const row = await load(tx, id);
      return row && !isPersonal(row) ? project(tx, row) : null;
    },
    async projectAfter(tx, p) {
      const row = await load(tx, p.objectId);
      if (!row || p.action === 'DELETE') return null;
      if (p.action === 'ACTIVATE') return { ...(await project(tx, row)), status: 'ACTIVE' };
      return project(tx, row, p.payload as ConnectionChange);
    },
    teamIds: async () => [],
    dependencies: async () => [],
    requiresApproval: platformRequiresApproval('mcp_connection'),
    async assertVisible(tx, principal, id) {
      await visible(tx, principal, id);
      const row = await load(tx, id);
      // Personal connections belong to one user and are never proposals.
      if (!row || isPersonal(row)) throw notFound('mcp_connection', id);
    },
    async validate(tx, p) {
      const row = await load(tx, p.objectId);
      if (!row || isPersonal(row)) return [{ code: 'object_missing', message: 'The connection no longer exists.' }];
      if (p.action === 'DELETE') return [];
      if (p.action === 'ACTIVATE') {
        if (row.approvedAt && row.status !== 'DISABLED') return [{ code: 'already_active', message: 'The connection is already live.' }];
        if (p.beforeSnapshot && stoppedSinceSubmit(row, p)) return [{ code: 'mcp_disabled_since_submit', message: 'The connection was disabled after this activation was submitted; submit it again to resume it.' }];
        return [...(await readinessProblems(tx, row)), ...(await policyProblems(tx, row, ApproveConnectionInput.parse({ allowedAgentIds: row.allowedAgentIds.includes('*') ? '*' : row.allowedAgentIds, confirmationPolicy: row.confirmationPolicy, sendCustomerClaims: row.sendCustomerClaims, healthCheckSeconds: row.healthCheckSeconds })))];
      }
      const change = p.payload as ConnectionChange;
      const problems: ApprovalProblem[] = [...(await unstagedRefProblems(tx, p, [change.headerCredential?.ref]))];
      if (change.policy) problems.push(...(await policyProblems(tx, row, ApproveConnectionInput.parse(change.policy))));
      if (change.tools) {
        const known = new Set((await toolLines(tx, row.id)).map((t) => t.id));
        const missing = change.tools.filter((t) => !known.has(t.toolId));
        if (missing.length) problems.push({ code: 'mcp_unknown_tools', message: 'Some tools do not belong to this connection or were removed.' });
      }
      return problems;
    },
    async activate(tx, actor, p) {
      const row = (await load(tx, p.objectId))!;
      // Going live needs the server (activateDeferred): nothing the checker saw changes here.
      if (p.action === 'ACTIVATE') return { kind: 'DEFERRED' };
      if (p.action === 'UPDATE') await applyChange(tx, actor, row, p.payload as ConnectionChange, deps);
      else await releaseSecrets(tx, { kind: 'mcp_connection', objectId: row.id }, await deleteConnectionRows(tx, actor, row));
      return { kind: 'DONE' };
    },
    async activateDeferred(db, actor, p) {
      const row = await load(db, p.objectId);
      if (!row) throw validation('object_missing', 'The connection no longer exists');
      // A redelivery after the commit below (crash before the spine's stamp) is a no-op.
      if (activationCommitted(row, p)) return;
      await probeToolSet(deps, db, row, (p.afterSnapshot as { toolSetHash?: string | null } | null)?.toolSetHash ?? null);
      await db.transaction(async (tx) => {
        const [locked] = await tx.select().from(mcpConnections).where(eq(mcpConnections.id, p.objectId)).for('update');
        if (!locked) throw validation('object_missing', 'The connection no longer exists');
        if (activationCommitted(locked, p)) return;
        // Disabled while the server was probed: the stop wins, never undone by this activation.
        if (stoppedSinceSubmit(locked, p)) throw validation('mcp_disabled_since_submit', 'The connection was disabled after this activation was submitted.');
        await writeConnectionPolicy(tx, actor, locked, null, { now: new Date(), live: { approvedBy: p.decidedBy } });
      });
    },
    async settled(db, p) {
      return p.action === 'ACTIVATE' && activationCommitted(await load(db, p.objectId), p);
    },
    async liveObjects(tx) {
      const rows = await tx.select({ id: mcpConnections.id, ownerUserId: mcpConnections.ownerUserId, approvedAt: mcpConnections.approvedAt, status: mcpConnections.status }).from(mcpConnections);
      return rows.filter((r) => r.ownerUserId === null && r.approvedAt !== null && r.status !== 'DISABLED').map((r) => r.id);
    },
    title: (p: ProposalRow, before) => platformTitle(p, before, { noun: 'MCP connection', resumed: before?.['status'] === 'DISABLED' }),
  };
}
