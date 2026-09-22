import { and, eq, inArray } from 'drizzle-orm';
import { Permission, assertCan, type Principal } from '@ocso/auth';
import { emitEvent, recordAudit, type ActorContext } from '@ocso/application';
import { DomainError, notFound, validation } from '@ocso/domain';
import { conversations, mcpConnections, toolCalls, tools, uuidv7, type Db } from '@ocso/db';
import { authorizeToolCall, sanitizeForAudit, type ConnectionRecord, type SchemaValidator, type ToolRecord } from '@ocso/tools';
import { argsHashOf, type ClaimsIssuer, type ToolProviderFactory } from './runner.js';

type ToolRow = typeof tools.$inferSelect;
type ConnectionRow = typeof mcpConnections.$inferSelect;

const toRecord = (t: ToolRow): ToolRecord => ({
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
});

const toConnection = (c: ConnectionRow): ConnectionRecord => ({
  id: c.id,
  name: c.name,
  status: c.status,
  scope: c.scope,
  ownerUserId: c.ownerUserId,
  allowedAgentIds: c.allowedAgentIds.includes('*') ? 'ALL' : c.allowedAgentIds,
  grantedScopes: c.grantedScopes,
  confirmationPolicy: c.confirmationPolicy,
});

/**
 * Human-side tool execution (docs/08 §7, design/01 "Confirm and run" and the
 * composer's Tool action mode). Same authorizer as the agent path; execution
 * is attributed to the human and audited. Callers check conversation access.
 */
export class HumanToolService {
  constructor(
    private readonly db: Db,
    private readonly providers: ToolProviderFactory,
    private readonly validate: SchemaValidator,
    private readonly claims: ClaimsIssuer | null = null,
  ) {}

  /** Tools the principal may run from the workspace (approved, role-allowed, usable connections). */
  async available(principal: Principal): Promise<Array<{ id: string; name: string; description: string; riskClass: string; connection: string; inputSchema: Record<string, unknown> }>> {
    const rows = await this.db
      .select({ t: tools, c: mcpConnections })
      .from(tools)
      .innerJoin(mcpConnections, eq(mcpConnections.id, tools.connectionId))
      .where(and(eq(tools.approved, true), eq(tools.enabled, true), inArray(mcpConnections.status, ['ACTIVE', 'DEGRADED'])));
    return rows
      .filter(({ t, c }) => t.humanRoles.includes(principal.role) && (c.scope === 'SHARED' || c.ownerUserId === principal.userId))
      .map(({ t, c }) => ({ id: t.id, name: t.title ?? t.name, description: t.description, riskClass: t.riskClass, connection: c.name, inputSchema: t.inputSchema }));
  }

  /** Confirm a sensitive call the agent proposed; executes it as the confirming human. */
  async confirm(actor: ActorContext, toolCallId: string) {
    const principal = actor.principal!;
    assertCan(principal, Permission.TOOLS_CONFIRM_SENSITIVE);
    const call = await this.pending(toolCallId);
    const { tool, connection } = await this.load(call.toolId!);
    // Execute exactly what was proposed and shown for confirmation — never the redacted audit copy.
    const args = call.pendingArgs;
    if (args === null || argsHashOf(args) !== call.argsHash) throw new DomainError('conflict', 'pending_args_mismatch', 'Proposed arguments are no longer available');
    const decision = authorizeToolCall(
      { tool: toRecord(tool), connection: toConnection(connection), grant: null, actor: { kind: 'HUMAN', principal }, args, argsHash: call.argsHash, confirmation: { approvedByUserId: principal.userId, argsHash: call.argsHash } },
      this.validate,
    );
    if (decision.outcome === 'DENY') throw new DomainError('policy_denied', decision.code, decision.reason);
    await this.db.update(toolCalls).set({ status: 'RUNNING', pendingArgs: null, confirmedBy: principal.userId, confirmedAt: new Date() }).where(eq(toolCalls.id, toolCallId));
    const result = await this.execute(actor, toolCallId, call.conversationId, tool, connection, args, `confirm:${toolCallId}`);
    await this.db.transaction(async (tx) => {
      await emitEvent(tx, actor, 'tool.confirmation_decided', { toolCallId, decision: 'APPROVED', userId: principal.userId }, { conversationId: call.conversationId });
      await recordAudit(tx, actor, {
        action: 'tool.confirm',
        targetType: 'tool_call',
        targetId: toolCallId,
        summary: `${principal.displayName} confirmed ${tool.title ?? tool.name}`,
        confirmation: { confirmedBy: principal.userId, reason: call.confirmationReason },
        after: sanitizeForAudit(args),
      });
    });
    return result;
  }

  async deny(actor: ActorContext, toolCallId: string, reason: string): Promise<void> {
    const principal = actor.principal!;
    assertCan(principal, Permission.TOOLS_CONFIRM_SENSITIVE);
    const call = await this.pending(toolCallId);
    await this.db.transaction(async (tx) => {
      await tx.update(toolCalls).set({ status: 'DENIED', pendingArgs: null, decisionCode: 'human_denied', decisionReason: reason, confirmedBy: principal.userId, confirmedAt: new Date(), completedAt: new Date() }).where(eq(toolCalls.id, toolCallId));
      await emitEvent(tx, actor, 'tool.confirmation_decided', { toolCallId, decision: 'DENIED', userId: principal.userId }, { conversationId: call.conversationId });
      await recordAudit(tx, actor, { action: 'tool.deny', targetType: 'tool_call', targetId: toolCallId, summary: `${principal.displayName} denied ${call.toolName}: ${reason}` });
    });
  }

  /** A human runs an approved tool directly from the workspace. */
  async run(actor: ActorContext, conversationId: string, toolId: string, args: unknown, confirmed: boolean) {
    const principal = actor.principal!;
    assertCan(principal, Permission.TOOLS_EXECUTE_HUMAN);
    const { tool, connection } = await this.load(toolId);
    const argsHash = argsHashOf(args);
    const decision = authorizeToolCall(
      {
        tool: toRecord(tool),
        connection: toConnection(connection),
        grant: null,
        actor: { kind: 'HUMAN', principal },
        args,
        argsHash,
        // A human's explicit "Confirm and run" is the confirmation for their own action.
        confirmation: confirmed ? { approvedByUserId: principal.userId, argsHash } : null,
      },
      this.validate,
    );
    if (decision.outcome === 'DENY') throw new DomainError('policy_denied', decision.code, decision.reason);
    if (decision.outcome === 'REQUIRE_CONFIRMATION') throw validation('confirmation_required', decision.reason, { requiresConfirmation: true });
    const id = uuidv7();
    await this.db.insert(toolCalls).values({
      id,
      conversationId,
      toolId,
      toolName: tool.title ?? tool.name,
      connectionId: connection.id,
      actorType: 'HUMAN',
      actorId: principal.userId,
      onBehalfOfUserId: principal.userId,
      argsSanitized: sanitizeForAudit(args) as Record<string, unknown>,
      argsHash,
      status: 'RUNNING',
      ...(confirmed ? { confirmedBy: principal.userId, confirmedAt: new Date() } : {}),
    });
    const result = await this.execute(actor, id, conversationId, tool, connection, args, `human:${id}`);
    if (tool.riskClass !== 'READ') {
      await this.db.transaction((tx) =>
        recordAudit(tx, actor, { action: 'tool.human_execute', targetType: 'tool_call', targetId: id, summary: `${principal.displayName} ran ${tool.title ?? tool.name}`, after: sanitizeForAudit(args) }),
      );
    }
    return { toolCallId: id, ...result };
  }

  private async execute(actor: ActorContext, toolCallId: string, conversationId: string | null, tool: ToolRow, connection: ConnectionRow, args: unknown, idempotencyKey: string) {
    const provider = await this.providers.forConnection(connection.id);
    const customerClaims = await this.claimsFor(conversationId, connection, tool);
    const outcome = await provider.invoke({ toolCallId, toolName: tool.name, args, timeoutMs: 30_000, customerClaims, idempotencyKey: tool.riskClass === 'READ' ? undefined : idempotencyKey });
    const ok = outcome.status === 'SUCCEEDED';
    await this.db.transaction(async (tx) => {
      await tx
        .update(toolCalls)
        .set(
          outcome.status === 'SUCCEEDED'
            ? { status: 'SUCCEEDED', resultSummary: sanitizeForAudit(outcome.output.type === 'json' ? outcome.output.value : { text: String(outcome.output.value).slice(0, 2_000) }) as Record<string, unknown>, latencyMs: outcome.latencyMs, externalCorrelationId: outcome.externalCorrelationId ?? null, completedAt: new Date() }
            : { status: 'FAILED', errorCategory: outcome.errorCategory, errorMessage: outcome.message, latencyMs: outcome.latencyMs, completedAt: new Date() },
        )
        .where(eq(toolCalls.id, toolCallId));
      if (conversationId) {
        await emitEvent(tx, actor, ok ? 'tool.completed' : 'tool.failed', ok ? { toolCallId, toolName: tool.name, latencyMs: outcome.latencyMs } : { toolCallId, toolName: tool.name, errorCategory: outcome.status === 'FAILED' ? outcome.errorCategory : 'internal' }, { conversationId });
      }
    });
    return outcome.status === 'SUCCEEDED' ? { status: 'SUCCEEDED' as const, output: outcome.output } : { status: 'FAILED' as const, error: outcome.message };
  }

  /** Trusted connections get the conversation's customer claims, exactly as on the agent path. */
  private async claimsFor(conversationId: string | null, connection: ConnectionRow, tool: ToolRow): Promise<string | undefined> {
    if (!this.claims || !connection.sendCustomerClaims || !conversationId) return undefined;
    const [conv] = await this.db.select({ customerId: conversations.customerId, agentId: conversations.agentId }).from(conversations).where(eq(conversations.id, conversationId));
    if (!conv) return undefined;
    return this.claims.issue({ customerId: conv.customerId, conversationId, agentId: conv.agentId, connectionId: connection.id, scopes: tool.requiredScopes });
  }

  private async pending(toolCallId: string) {
    const [call] = await this.db.select().from(toolCalls).where(eq(toolCalls.id, toolCallId));
    if (!call || !call.toolId) throw notFound('tool_call', toolCallId);
    if (call.status !== 'AWAITING_CONFIRMATION') throw new DomainError('conflict', 'not_awaiting_confirmation', `Tool call is ${call.status.toLowerCase()}`);
    if (call.confirmationExpiresAt && call.confirmationExpiresAt < new Date()) {
      await this.db.update(toolCalls).set({ status: 'EXPIRED', pendingArgs: null, completedAt: new Date() }).where(eq(toolCalls.id, toolCallId));
      throw new DomainError('conflict', 'confirmation_expired', 'The confirmation window has expired');
    }
    return call;
  }

  private async load(toolId: string) {
    const [row] = await this.db.select({ t: tools, c: mcpConnections }).from(tools).innerJoin(mcpConnections, eq(mcpConnections.id, tools.connectionId)).where(eq(tools.id, toolId));
    if (!row) throw notFound('tool', toolId);
    return { tool: row.t, connection: row.c };
  }
}
