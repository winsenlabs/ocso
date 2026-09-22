import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { ControlState, ToolResultOutput } from '@ocso/domain';
import { toolCalls, uuidv7, type Db } from '@ocso/db';
import { canonicalJson } from '@ocso/prompt-compiler';
import { emitEvent } from '@ocso/application';
import { currentTraceId, ocsoMetrics } from '@ocso/observability';
import { authorizeToolCall, sanitizeForAudit, type SchemaValidator, type ToolProvider } from '@ocso/tools';
import type { ToolCallRequest } from '@ocso/model-providers';
import type { AgentToolCatalog } from './catalog.js';
import { HANDOFF_TOOL, HandoffArgs, SEARCH_HISTORY_TOOL, searchHistory, type HandoffArgs as HandoffArgsT } from './builtins.js';

export interface ToolProviderFactory {
  forConnection(connectionId: string): Promise<ToolProvider>;
}

/** Issues short-lived customer identity claims for trusted connections (docs/08 §4). */
export interface ClaimsIssuer {
  issue(input: { customerId: string; conversationId: string; agentId: string; scopes: readonly string[] }): Promise<string>;
}

export interface ToolRunContext {
  conversationId: string;
  turnId: string;
  agentId: string;
  customerId: string;
  controlState: ControlState;
  correlationId: string;
  historyWindowStartSeq: number;
  sendCustomerClaims: (connectionId: string) => boolean;
}

export type ToolRunOutcome = {
  toolCallId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'DENIED' | 'AWAITING_CONFIRMATION';
  output: ToolResultOutput;
  handoff?: HandoffArgsT | undefined;
};

const MAX_OUTPUT_CHARS = 12_000;
const CONFIRMATION_TTL_MS = 30 * 60_000;

export const argsHashOf = (args: unknown) => createHash('sha256').update(canonicalJson(args ?? null)).digest('hex');

/**
 * Executes model-requested tool calls (ADR-014): authorize in code → persist
 * the request before any side effect → execute → persist sanitized result →
 * return a typed, safe result to the model.
 */
export class ToolRunner {
  constructor(
    private readonly db: Db,
    private readonly catalog: AgentToolCatalog,
    private readonly providers: ToolProviderFactory,
    private readonly validate: SchemaValidator,
    private readonly claims: ClaimsIssuer | null,
    private readonly timeoutMs = 20_000,
  ) {}

  async run(call: ToolCallRequest, ctx: ToolRunContext): Promise<ToolRunOutcome> {
    if (call.toolName === HANDOFF_TOOL) return this.handoff(call, ctx);
    if (call.toolName === SEARCH_HISTORY_TOOL) {
      const output = await searchHistory(this.db, ctx.customerId, { conversationId: ctx.conversationId, seq: ctx.historyWindowStartSeq }, call.input);
      return { toolCallId: call.toolCallId, status: output.type === 'error' ? 'FAILED' : 'SUCCEEDED', output };
    }
    const entry = this.catalog.entries.get(call.toolName) ?? null;
    const argsHash = argsHashOf(call.input);
    const decision = authorizeToolCall(
      {
        tool: entry?.tool ?? null,
        connection: entry?.connection ?? null,
        grant: entry?.grant ?? null,
        actor: { kind: 'AGENT', agentId: ctx.agentId, conversationState: ctx.controlState },
        args: call.input,
        argsHash,
        confirmation: null,
      },
      this.validate,
    );
    const id = uuidv7();
    const base = {
      id,
      conversationId: ctx.conversationId,
      turnId: ctx.turnId,
      toolId: entry?.tool.id ?? null,
      toolName: entry?.tool.displayName ?? call.toolName,
      connectionId: entry?.connection?.id ?? null,
      actorType: 'AGENT' as const,
      actorId: ctx.agentId,
      modelToolCallId: call.toolCallId,
      argsSanitized: sanitizeForAudit(call.input) as Record<string, unknown>,
      argsHash,
      idempotencyKey: `tool:${ctx.turnId}:${call.toolCallId}`,
      traceId: currentTraceId(),
    };

    if (decision.outcome === 'DENY') {
      await this.db.insert(toolCalls).values({ ...base, status: 'DENIED', decisionCode: decision.code, decisionReason: decision.reason, completedAt: new Date() });
      ocsoMetrics().toolCalls.add(1, { outcome: 'denied' });
      return { toolCallId: call.toolCallId, status: 'DENIED', output: { type: 'error', value: `Not permitted: ${decision.reason}. Do not retry this action.` } };
    }
    if (decision.outcome === 'REQUIRE_CONFIRMATION') {
      await this.db.transaction(async (tx) => {
        await tx.insert(toolCalls).values({
          ...base,
          pendingArgs: (call.input ?? {}) as Record<string, unknown>,
          status: 'AWAITING_CONFIRMATION',
          confirmationReason: decision.reason,
          confirmationExpiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS),
        });
        await emitEvent(tx, { correlationId: ctx.correlationId }, 'tool.confirmation_requested', { toolCallId: id, toolName: base.toolName }, { conversationId: ctx.conversationId, agentId: ctx.agentId });
      });
      return {
        toolCallId: call.toolCallId,
        status: 'AWAITING_CONFIRMATION',
        output: {
          type: 'json',
          value: {
            status: 'awaiting_human_confirmation',
            reason: decision.reason,
            instruction: 'A colleague must confirm this action. Tell the customer a colleague will confirm it here shortly. Do not retry.',
          },
        },
      };
    }

    await this.db.transaction(async (tx) => {
      await tx.insert(toolCalls).values({ ...base, status: 'RUNNING' });
      await emitEvent(tx, { correlationId: ctx.correlationId }, 'tool.started', { toolCallId: id, toolName: base.toolName, connectionId: base.connectionId }, { conversationId: ctx.conversationId, agentId: ctx.agentId });
    });
    return this.execute(id, call, entry!, ctx);
  }

  private async execute(id: string, call: ToolCallRequest, entry: NonNullable<ReturnType<AgentToolCatalog['entries']['get']>>, ctx: ToolRunContext): Promise<ToolRunOutcome> {
    const connectionId = entry.connection!.id;
    const started = performance.now();
    let outcome;
    try {
      const provider = await this.providers.forConnection(connectionId);
      const claims =
        this.claims && ctx.sendCustomerClaims(connectionId)
          ? await this.claims.issue({ customerId: ctx.customerId, conversationId: ctx.conversationId, agentId: ctx.agentId, scopes: entry.tool.requiredScopes })
          : undefined;
      outcome = await provider.invoke({
        toolCallId: id,
        toolName: entry.serverName,
        args: call.input,
        timeoutMs: this.timeoutMs,
        customerClaims: claims,
        idempotencyKey: entry.tool.riskClass === 'READ' ? undefined : `tool:${ctx.turnId}:${call.toolCallId}`,
      });
    } catch {
      outcome = { status: 'FAILED' as const, errorCategory: 'tool_unavailable' as const, message: 'The tool could not be reached', latencyMs: Math.round(performance.now() - started) };
    }
    const final = outcome;
    const eventCtx = { conversationId: ctx.conversationId, agentId: ctx.agentId };
    await this.db.transaction(async (tx) => {
      if (final.status === 'SUCCEEDED') {
        await tx
          .update(toolCalls)
          .set({
            status: 'SUCCEEDED',
            resultSummary: sanitizeForAudit(summarize(final.output)) as Record<string, unknown>,
            latencyMs: final.latencyMs,
            externalCorrelationId: final.externalCorrelationId ?? null,
            completedAt: new Date(),
          })
          .where(eq(toolCalls.id, id));
        await emitEvent(tx, { correlationId: ctx.correlationId }, 'tool.completed', { toolCallId: id, toolName: entry.tool.displayName, latencyMs: final.latencyMs }, eventCtx);
      } else {
        await tx
          .update(toolCalls)
          .set({ status: 'FAILED', errorCategory: final.errorCategory, errorMessage: final.message, latencyMs: final.latencyMs, completedAt: new Date() })
          .where(eq(toolCalls.id, id));
        await emitEvent(tx, { correlationId: ctx.correlationId }, 'tool.failed', { toolCallId: id, toolName: entry.tool.displayName, errorCategory: final.errorCategory }, eventCtx);
      }
    });
    const label = final.status === 'SUCCEEDED' ? 'ok' : 'failed';
    const m = ocsoMetrics();
    m.toolCalls.add(1, { outcome: label, risk: entry.tool.riskClass });
    m.toolDuration.record(final.latencyMs / 1000, { outcome: label });
    return final.status === 'SUCCEEDED'
      ? { toolCallId: call.toolCallId, status: 'SUCCEEDED', output: truncate(final.output) }
      : { toolCallId: call.toolCallId, status: 'FAILED', output: { type: 'error', value: final.message } };
  }

  private async handoff(call: ToolCallRequest, ctx: ToolRunContext): Promise<ToolRunOutcome> {
    const parsed = HandoffArgs.safeParse(call.input);
    if (!parsed.success) return { toolCallId: call.toolCallId, status: 'FAILED', output: { type: 'error', value: 'reason and summary are required' } };
    return {
      toolCallId: call.toolCallId,
      status: 'SUCCEEDED',
      handoff: parsed.data,
      output: { type: 'json', value: { status: 'handoff_requested', instruction: 'Tell the customer a colleague will continue here shortly. Do not promise a time.' } },
    };
  }
}

function summarize(output: ToolResultOutput): unknown {
  if (output.type === 'json') return output.value;
  return { text: String(output.value).slice(0, 2_000) };
}

function truncate(output: ToolResultOutput): ToolResultOutput {
  const text = output.type === 'json' ? JSON.stringify(output.value) : String(output.value);
  if (text.length <= MAX_OUTPUT_CHARS) return output;
  return { type: 'text', value: `${text.slice(0, MAX_OUTPUT_CHARS)}… [truncated]` };
}
