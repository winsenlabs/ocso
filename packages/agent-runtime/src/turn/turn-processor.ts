import { randomUUID } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { isDomainError, type ControlState } from '@ocso/domain';
import { channels, conversations, interactions, turns, virtualAgents, uuidv7, type Db } from '@ocso/db';
import { applyControl, emitEvent, publishEphemeral, systemActor } from '@ocso/application';
import type { HandlerResult, QueueAdapter, QueueMessage } from '@ocso/queue';
import type { ModelInputCapabilities } from '@ocso/prompt-compiler';
import { ocsoMetrics, withSpan, type Logger } from '@ocso/observability';
import { LeaseLostError, type LeaseManager } from '../leases/lease-manager.js';
import type { ContextBuilder } from '../context/context-builder.js';
import type { ModelGateway } from '../model/gateway.js';
import type { AgentToolCatalog } from '../tools/catalog.js';
import type { ToolRunner } from '../tools/runner.js';
import type { MediaMaterializer } from '../delivery/media.js';
import { runAgentLoop, type LoopResult } from './agent-loop.js';
import { TurnSupersededError, TurnWriter, type TurnIdentity } from './persist.js';

export interface TurnProcessorDeps {
  db: Db;
  queue: QueueAdapter;
  leases: LeaseManager;
  gateway: ModelGateway;
  context: ContextBuilder;
  media: MediaMaterializer;
  toolRunner: (catalog: AgentToolCatalog) => ToolRunner;
  capabilitiesFor: (profileId: string) => Promise<ModelInputCapabilities>;
  logger: Logger;
  /** Summarize when this many answered messages are not yet covered by a summary. */
  summarizeAfter: number;
}

export const DEFAULT_HANDOFF_MESSAGE = "I've asked a colleague to help with this. They'll reply here shortly.";
const MAX_DRAIN_ITERATIONS = 8;

type RunOutcome = 'processed' | 'nothing' | 'skipped';

/**
 * `conversation.turn` handler (docs/04 §3, docs/10 §2–3). Holds the lease for
 * the whole turn, drains all unanswered customer messages, and never writes a
 * customer-visible message without fencing + a fresh control-state check.
 */
export class TurnProcessor {
  private readonly active = new Map<string, { controller: AbortController; committed: boolean }>();
  /** Conversations inside handle() in this process (including between drained turns). */
  private readonly handling = new Set<string>();

  constructor(private readonly deps: TurnProcessorDeps) {}

  /** Conversations with a turn in flight on this worker (heartbeat set). */
  activeConversations(): string[] {
    return [...this.active.keys()];
  }

  /** CANCEL_AND_RESTART support: abort only if nothing customer-visible or side-effecting happened. */
  cancel(conversationId: string): boolean {
    const turn = this.active.get(conversationId);
    if (!turn || turn.committed) return false;
    turn.controller.abort(new Error('superseded by newer customer message'));
    return true;
  }

  async handle(message: QueueMessage<{ conversationId: string }>): Promise<HandlerResult> {
    const conversationId = message.payload.conversationId;
    // This process is already draining the conversation and will pick up the new message;
    // re-acquiring here would bump the lease and fence the turn in flight.
    if (this.handling.has(conversationId)) return { kind: 'defer', delaySeconds: 2 };
    const lease = await this.deps.leases.acquire(conversationId);
    if (lease.kind === 'busy_elsewhere') return { kind: 'defer', delaySeconds: 2 };
    this.handling.add(conversationId);
    try {
      for (let i = 0; i < MAX_DRAIN_ITERATIONS; i++) {
        await this.runOnce(conversationId, lease.leaseVersion, message.attempt);
        if (await this.deps.leases.markIdle(conversationId, lease.leaseVersion)) return { kind: 'ack' };
      }
      return { kind: 'retry', delaySeconds: 1, reason: 'drain limit reached' };
    } catch (err) {
      if (err instanceof LeaseLostError) return { kind: 'ack' };
      this.deps.logger.error({ err, conversationId }, 'turn failed');
      await this.deps.leases.release(conversationId).catch(() => {});
      const retriable = isDomainError(err) ? err.retriable : true;
      return retriable ? { kind: 'retry', delaySeconds: Math.min(60, 2 ** message.attempt), reason: (err as Error).message } : { kind: 'dead', reason: (err as Error).message };
    } finally {
      this.handling.delete(conversationId);
    }
  }

  private async runOnce(conversationId: string, leaseVersion: number, attempt: number): Promise<RunOutcome> {
    const { db } = this.deps;
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    if (!conv) return 'skipped';
    const [agent] = await db.select().from(virtualAgents).where(eq(virtualAgents.id, conv.agentId));
    if (!agent || agent.status !== 'LIVE' || !agent.modelProfileId) return 'skipped';
    const pending = await db
      .select({ id: interactions.id, seq: interactions.seq })
      .from(interactions)
      .where(and(eq(interactions.conversationId, conversationId), eq(interactions.actorType, 'CUSTOMER'), eq(interactions.kind, 'MESSAGE'), gt(interactions.seq, conv.lastProcessedSeq)));
    if (!pending.length) return 'nothing';

    const correlationId = randomUUID();
    let state = conv.controlState as ControlState;
    let resuming = false;
    if (state === 'AI_RESUMING') {
      await db.transaction(async (tx) => {
        await this.deps.leases.assertHeld(tx, conversationId, leaseVersion);
        await applyControl(tx, conversationId, {
          command: 'RESUME_AI',
          actor: systemActor('runtime', correlationId, agent.name),
          transitionActor: 'SYSTEM',
          description: `${agent.name} resumed with the handover context`,
          patch: { assignedUserId: null },
          now: new Date(),
        });
        await emitEvent(tx, { correlationId }, 'ai.resumed', { handoffId: null }, { conversationId, agentId: agent.id });
      });
      state = 'AI_ACTIVE';
      resuming = true;
    }
    if (state !== 'AI_ACTIVE') return 'skipped';

    await this.deps.media.materializeAll(pending.map((p) => p.id));
    const [channel] = conv.channelId ? await db.select().from(channels).where(eq(channels.id, conv.channelId)) : [];
    const turnId = uuidv7();
    const ident: TurnIdentity = { conversationId, turnId, agentId: agent.id, agentName: agent.name, channelId: conv.channelId, leaseVersion, correlationId };
    await db.insert(turns).values({
      id: turnId,
      conversationId,
      workerId: this.deps.leases.workerId,
      leaseVersion,
      seqFrom: pending[0]!.seq,
      seqTo: pending.at(-1)!.seq,
      promptVersionId: agent.activePromptVersionId,
      modelProfileId: agent.modelProfileId,
    });
    await publishEphemeral(db, correlationId, 'agent.turn_started', { turnId, workerId: this.deps.leases.workerId }, { conversationId, agentId: agent.id });

    const writer = new TurnWriter(db, this.deps.leases, this.deps.queue);
    const turn = { controller: new AbortController(), committed: false };
    this.active.set(conversationId, turn);
    const started = performance.now();
    try {
      await withSpan('ocso.turn', { 'ocso.agent': agent.name, 'ocso.cache_layer': 'pending' }, async (span) => {
        const [capabilities] = await Promise.all([this.deps.capabilitiesFor(agent.modelProfileId!)]);
        const ctx = await this.deps.context.build(conv, agent, channel ?? null, capabilities, resuming);
        span.setAttribute('ocso.cache_layer', ctx.cacheLayer);
        const result = await runAgentLoop(
          this.deps.gateway,
          this.deps.toolRunner(ctx.catalog),
          {
            profileId: agent.modelProfileId!,
            maxSteps: agent.maxToolSteps,
            context: ctx,
            usage: { correlationId, conversationId, turnId, agentId: agent.id, purpose: 'TURN' },
            signal: turn.controller.signal,
            toolContext: {
              conversationId,
              turnId,
              agentId: agent.id,
              customerId: conv.customerId,
              controlState: state,
              correlationId,
              historyWindowStartSeq: ctx.windowStartSeq,
            },
          },
          {
            onDelta: (text) => void publishEphemeral(db, correlationId, 'agent.response_delta', { turnId, interactionId: turnId, delta: text }, { conversationId }).catch(() => {}),
            emitInterim: async (text) => {
              turn.committed = true;
              await writer.agentMessage(ident, text);
            },
            onStatus: (status) => void publishEphemeral(db, correlationId, 'agent.status', { turnId, status }, { conversationId }).catch(() => {}),
          },
        );
        await this.finish(writer, ident, ctx, result, started, turn);
      });
      await this.maybeSummarize(conversationId);
      return 'processed';
    } catch (err) {
      if (err instanceof TurnSupersededError) {
        await writer.fail(ident, 'SUPERSEDED', null);
        return 'skipped';
      }
      if (turn.controller.signal.aborted) {
        await writer.fail(ident, 'CANCELLED', null);
        return 'processed';
      }
      if (err instanceof LeaseLostError) {
        // Fenced by a newer lease holder: close this turn's record (no customer-visible effect was committed).
        await writer.fail(ident, 'SUPERSEDED', { category: 'lease_lost', message: 'Another worker took over the conversation' }).catch(() => {});
        throw err;
      }
      const category = isDomainError(err) ? err.category : 'internal';
      await writer.fail(ident, 'FAILED', { category, message: (err as Error).message });
      if (attempt >= 2 && (category.startsWith('provider') || category === 'timeout' || category === 'policy_denied')) {
        // Model persistently unavailable: route to humans instead of leaving the customer waiting.
        await this.handoffOnOutage(writer, ident, category);
        return 'processed';
      }
      throw err;
    } finally {
      this.active.delete(conversationId);
      ocsoMetrics().turnDuration.record((performance.now() - started) / 1000, { agent: agent.name });
    }
  }

  private async finish(writer: TurnWriter, ident: TurnIdentity, ctx: Parameters<TurnWriter['complete']>[1], result: LoopResult, started: number, turn: { committed: boolean }): Promise<void> {
    const handoff = this.handoffIntent(result);
    const text = result.finalText ?? (handoff ? DEFAULT_HANDOFF_MESSAGE : null);
    if (text) {
      turn.committed = true;
      await writer.agentMessage(ident, text);
    }
    const kind = result.awaitingConfirmation ? 'AWAITING_CONFIRMATION' : handoff ? 'HANDOFF' : text ? 'REPLIED' : 'NO_REPLY';
    await writer.complete(
      ident,
      ctx,
      {
        kind,
        steps: result.steps,
        latencyMs: Math.round(performance.now() - started),
        ttftMs: result.last?.ttftMs ?? null,
        providerId: result.last?.identity.providerId ?? null,
        model: result.last?.identity.model ?? null,
      },
      handoff,
    );
  }

  private handoffIntent(result: LoopResult) {
    if (result.handoff) {
      return {
        reason: result.handoff.reason,
        summary: result.handoff.summary,
        priority: result.handoff.priority,
        trigger: result.handoff.customerAskedForHuman ? ('CUSTOMER_REQUEST' as const) : ('AGENT_DECISION' as const),
      };
    }
    if (result.awaitingConfirmation) {
      return { reason: `sensitive action needs confirmation: ${result.awaitingConfirmation.reason}`, summary: result.finalText ?? '', priority: 'P1' as const, trigger: 'SENSITIVE_ACTION' as const };
    }
    if (result.stepLimitReached) {
      return { reason: 'agent could not complete the request within its step limit', summary: '', trigger: 'TOOL_FAILURE' as const };
    }
    return null;
  }

  private async handoffOnOutage(writer: TurnWriter, ident: TurnIdentity, category: string): Promise<void> {
    try {
      await writer.agentMessage(ident, DEFAULT_HANDOFF_MESSAGE);
    } catch {
      // Best effort; the handoff below still routes the conversation to humans.
    }
    await writer.outageHandoff(ident, `AI temporarily unavailable (${category})`);
  }

  private async maybeSummarize(conversationId: string): Promise<void> {
    const [conv] = await this.deps.db
      .select({ lastProcessedSeq: conversations.lastProcessedSeq, summaryVersion: conversations.summaryVersion })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    if (!conv || conv.lastProcessedSeq < this.deps.summarizeAfter) return;
    await this.deps.queue.publish('conversation.summarize', { conversationId }, { groupKey: conversationId, dedupeKey: `summarize:${conversationId}:${Math.floor(conv.lastProcessedSeq / this.deps.summarizeAfter)}` });
  }
}
