import { and, asc, count, eq, lt, sql } from 'drizzle-orm';
import { advanceSession, type Classification, type ClassifyStep, type RoutingEvent, type RoutingSession } from '@ocso/domain';
import { conversationRouting, conversations, interactions, routerVersions, type Db, type DbOrTx } from '@ocso/db';
import type { QueueAdapter } from '@ocso/queue';
import { lockConversation, type ConversationRow } from '../conversations/control.js';
import { appendSystemEvent } from '../conversations/interaction-writer.js';
import type { SessionWindowHours } from '../conversations/session-window.js';
import { loadRouter, loadRouterAtVersion, type ActiveRouter } from './router-load.js';
import { writeRouterMessage } from './router-messages.js';
import { completeRoute, continueRoute, startNewConversation } from './routing-apply.js';
import { customerMessagesAfter, knownContext, replyOf, sessionColumns, sessionOf, transcript, type RoutingRow } from './routing-state.js';

/** What a CLASSIFY step asks the model (the worker binds this to the model gateway). */
export interface ClassifyRequest {
  conversationId: string;
  step: ClassifyStep;
  /** The customer's messages (and the router's follow-up questions) since routing started, oldest first. */
  transcript: ReadonlyArray<{ from: 'customer' | 'router'; text: string }>;
  correlationId: string;
}
export type RouterClassifier = (request: ClassifyRequest) => Promise<Classification>;

export interface RoutingEngineDeps {
  db: Db;
  queue: QueueAdapter;
  classifier?: RouterClassifier | undefined;
  windowHours?: SessionWindowHours | undefined;
  now?: () => Date;
  onError?: (err: unknown, context: Record<string, unknown>) => void;
}

type StepOutcome =
  | { kind: 'idle' }
  | { kind: 'moved'; conversationId: string }
  | { kind: 'classify'; request: ClassifyRequest; expected: Date };

interface Effects {
  deliver: string[];
  turns: string[];
}

const MAX_STEPS = 12;
const SWEEP_BATCH = 100;
const UNCLASSIFIED: Classification = { label: null, confidence: 0, followUp: null };
/**
 * How long an issued CLASSIFY counts as in flight. Route jobs are not
 * serialized per conversation, so a second job must not re-issue a
 * classification another job is still waiting for (each would discard the
 * other's result). Past this bound the job is presumed dead (worker crash, a
 * hung provider) and the next route job — at the latest the sweep's re-signal
 * of a session with no `awaiting_since` — issues it again.
 */
export const CLASSIFY_IN_FLIGHT_MS = 120_000;

/**
 * `conversation.route` (PM/research/11 §5.3): runs a ROUTING conversation's
 * router over the customer's new messages — asks, re-asks, classifies with
 * the model, then decides (ROUTE_COMPLETE), continues or starts anew. The
 * caller holds the conversation lease; every step is one transaction and a
 * model call never runs inside one. Effects (deliveries, the agent's turn)
 * are published after each commit.
 */
export class RoutingEngine {
  constructor(private readonly deps: RoutingEngineDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async advance(conversationId: string, correlationId: string): Promise<void> {
    let id = conversationId;
    let classified: { stepId: string; result: Classification; expected: Date } | null = null;
    for (let i = 0; i < MAX_STEPS; i++) {
      const effects: Effects = { deliver: [], turns: [] };
      const outcome: StepOutcome = await this.deps.db.transaction((tx) => this.step(tx, id, { classified, timeout: false }, effects, correlationId));
      await this.publish(effects);
      classified = null;
      if (outcome.kind === 'idle') return;
      if (outcome.kind === 'moved') {
        id = outcome.conversationId;
        continue;
      }
      // No step left to apply the result in: leave it in flight (the next route job or the sweep re-issues it).
      if (i === MAX_STEPS - 1) return;
      const result = await this.classify(outcome.request);
      classified = { stepId: outcome.request.step.id, result, expected: outcome.expected };
    }
  }

  /** No answer within the router's timeout: fallback (or continue, for the returning question). */
  async expire(conversationId: string, correlationId: string): Promise<boolean> {
    const effects: Effects = { deliver: [], turns: [] };
    const outcome = await this.deps.db.transaction((tx) => this.step(tx, conversationId, { classified: null, timeout: true }, effects, correlationId));
    await this.publish(effects);
    return outcome.kind !== 'idle' || effects.turns.length > 0;
  }

  /**
   * Leader task (60 s): expire sessions waiting longer than their router's
   * timeout (the due check runs in SQL, so a long-timeout router cannot crowd
   * out a short one), and re-signal routing that stalled: a lost queue
   * message, an unanswered customer message, or a decision still waiting for
   * a queue with an agent.
   */
  async sweep(correlationId: string): Promise<{ expired: number; resignalled: number; overdue: number }> {
    const now = this.now();
    const due = sql`${conversationRouting.phase} <> 'DONE' AND ${conversationRouting.awaitingSince} IS NOT NULL AND ${conversations.controlState} = 'ROUTING'
      AND ${conversationRouting.awaitingSince} < ${now.toISOString()}::timestamptz - make_interval(mins => COALESCE((${routerVersions.definition} ->> 'timeoutMinutes')::int, 10))`;
    const waiting = await this.deps.db
      .select({ conversationId: conversationRouting.conversationId })
      .from(conversationRouting)
      .innerJoin(conversations, eq(conversations.id, conversationRouting.conversationId))
      .innerJoin(routerVersions, eq(routerVersions.id, conversationRouting.routerVersionId))
      .where(due)
      .orderBy(asc(conversationRouting.awaitingSince))
      .limit(SWEEP_BATCH);
    let expired = 0;
    for (const row of waiting) {
      try {
        if (await this.expire(row.conversationId, correlationId)) expired++;
      } catch (err) {
        this.deps.onError?.(err, { conversationId: row.conversationId, task: 'routing-timeout' });
      }
    }
    const overdue =
      waiting.length < SWEEP_BATCH
        ? 0
        : ((
            await this.deps.db
              .select({ n: count() })
              .from(conversationRouting)
              .innerJoin(conversations, eq(conversations.id, conversationRouting.conversationId))
              .innerJoin(routerVersions, eq(routerVersions.id, conversationRouting.routerVersionId))
              .where(due)
          )[0]?.n ?? 0);
    const unanswered = sql`EXISTS (SELECT 1 FROM ${interactions} i WHERE i.conversation_id = ${conversations.id} AND i.actor_type = 'CUSTOMER' AND i.kind = 'MESSAGE' AND i.seq > ${conversations.lastProcessedSeq})`;
    const stalled = await this.deps.db
      .select({ conversationId: conversationRouting.conversationId })
      .from(conversationRouting)
      .innerJoin(conversations, eq(conversations.id, conversationRouting.conversationId))
      .where(
        and(
          eq(conversations.controlState, 'ROUTING'),
          lt(conversationRouting.updatedAt, new Date(now.getTime() - 60_000)),
          // DONE while still ROUTING: a decision that never applied (rows from before the fix) — decide again.
          sql`(${conversationRouting.phase} = 'DONE' OR ${conversationRouting.awaitingSince} IS NULL OR ${unanswered})`,
        ),
      )
      .limit(SWEEP_BATCH);
    const minute = Math.floor(now.getTime() / 60_000);
    await Promise.allSettled(stalled.map((r) => this.deps.queue.publish('conversation.route', { conversationId: r.conversationId }, { groupKey: r.conversationId, dedupeKey: `route:${r.conversationId}:sweep:${minute}` })));
    return { expired, resignalled: stalled.length, overdue };
  }

  private async classify(request: ClassifyRequest): Promise<Classification> {
    if (!this.deps.classifier) return UNCLASSIFIED;
    try {
      return await this.deps.classifier(request);
    } catch (err) {
      // A model outage must not strand the customer: the step is left unset and routing moves on.
      this.deps.onError?.(err, { conversationId: request.conversationId, stepId: request.step.id, task: 'routing-classify' });
      // Recorded on the session (classifications[step].error), so an outage is told apart from low confidence.
      return { ...UNCLASSIFIED, error: classifierErrorCode(err) };
    }
  }

  private async publish(effects: Effects): Promise<void> {
    await Promise.allSettled([
      ...effects.deliver.map((interactionId) => this.deps.queue.publish('channel.deliver', { interactionId }, { dedupeKey: `deliver:${interactionId}` })),
      ...effects.turns.map((conversationId) => this.deps.queue.publish('conversation.turn', { conversationId }, { groupKey: conversationId, dedupeKey: `turn:${conversationId}:routed:${Date.now()}` })),
    ]);
  }

  private async activeFor(tx: DbOrTx, routerId: string | null, versionId: string | null): Promise<ActiveRouter | null> {
    if (!routerId || !versionId) return null;
    const router = await loadRouter(tx, routerId);
    return router ? loadRouterAtVersion(tx, router, versionId) : null;
  }

  private async step(tx: DbOrTx, conversationId: string, input: { classified: { stepId: string; result: Classification; expected: Date } | null; timeout: boolean }, effects: Effects, correlationId: string): Promise<StepOutcome> {
    const conv = await lockConversation(tx, conversationId);
    if (conv.controlState !== 'ROUTING') return { kind: 'idle' };
    const [row] = await tx.select().from(conversationRouting).where(eq(conversationRouting.conversationId, conversationId)).for('update');
    if (!row) return { kind: 'idle' };
    const active = await this.activeFor(tx, row.routerId, row.routerVersionId);
    const now = this.now();
    if (!active) {
      this.deps.onError?.(new Error('router version unavailable'), { conversationId, routerId: row.routerId });
      return { kind: 'idle' };
    }
    const def = active.definition;
    let session = sessionOf(row);
    // Every step is behind the router: only the decision is left (it found no queue with an agent last time,
    // or a row from before this was retried stayed DONE while ROUTING). Decide again.
    const deciding = session.phase === 'DONE' || (session.phase === 'STEPS' && session.stepIndex >= def.steps.length);
    if (deciding) session = { ...session, phase: 'STEPS', stepIndex: def.steps.length, awaiting: false };

    const pending = await customerMessagesAfter(tx, conversationId, conv.lastProcessedSeq);
    const events: Array<{ event: RoutingEvent; seq: number | null }> = [];
    const replies = () => pending.map((m) => ({ event: { type: 'REPLY' as const, reply: replyOf(m) }, seq: m.seq }));
    // A CLASSIFY was issued (the engine marks it with attempts ≥ 1, see below) and its result is not in yet.
    const current = session.phase === 'STEPS' ? def.steps[session.stepIndex] : undefined;
    const classifying = !deciding && !session.awaiting && current?.kind === 'CLASSIFY' && row.attempts > 0;
    const inFlight = classifying && now.getTime() - row.updatedAt.getTime() < CLASSIFY_IN_FLIGHT_MS;
    if (deciding) events.push({ event: { type: 'START' }, seq: null });
    else if (input.timeout) {
      // An answer that arrived before the sweep counts; the timeout applies only to real silence.
      if (session.awaiting && pending.length) events.push(...replies());
      else if (session.awaiting && row.awaitingSince && now.getTime() - row.awaitingSince.getTime() >= def.timeoutMinutes * 60_000) events.push({ event: { type: 'TIMEOUT' }, seq: null });
    } else if (input.classified) {
      // Stale: another job moved the session (it owns whatever comes next).
      if (row.updatedAt.getTime() !== input.classified.expected.getTime()) return { kind: 'idle' };
      // The customer wrote more while the model ran: classify again over the whole transcript
      // (those messages' own route jobs left them to this one) instead of applying a result that missed them.
      if (classifying && pending.length) events.push({ event: { type: 'START' }, seq: null });
      else events.push({ event: { type: 'CLASSIFIED', stepId: input.classified.stepId, result: input.classified.result }, seq: null });
    } else if (session.awaiting) events.push(...replies());
    // Another job's classification is in flight: leave the messages pending for it to fold in.
    else if (inFlight) return { kind: 'idle' };
    else events.push({ event: { type: 'START' }, seq: null });
    if (!events.length) return { kind: 'idle' };

    const ctx = await knownContext(tx, conv.customerId);
    let classify: ClassifyStep | null = null;
    let asked = false;
    for (const { event, seq } of events) {
      const result = advanceSession(def, session, event, ctx);
      session = result.session;
      for (const action of result.actions) {
        if (action.type === 'SEND') {
          asked = true;
          effects.deliver.push(
            await writeRouterMessage(tx, { conversation: conv, routerId: active.router.id, message: action.message, options: action.options, correlationId, now, windowHours: this.deps.windowHours }),
          );
        } else if (action.type === 'CLASSIFY') classify = action.step;
        else if (action.type === 'DECIDE') {
          // Saved as "deciding" (not DONE): if no queue can take the conversation it stays visible and is retried.
          await this.persist(tx, conv, row, { ...session, phase: 'STEPS', stepIndex: def.steps.length, awaiting: false }, pending, now, true);
          const done = await completeRoute(tx, { conversation: await lockConversation(tx, conversationId), row, active, queueId: action.queueId, outcome: action.outcome, ruleIndex: action.ruleIndex, reason: action.reason, correlationId, now });
          if (done === 'AI') effects.turns.push(conversationId);
          if (!done) await this.unroutable(tx, conv.id, row, active, action.queueId, deciding, correlationId, now);
          return { kind: 'idle' };
        } else if (action.type === 'CONTINUE') {
          await this.persist(tx, conv, row, session, pending, now, true);
          await continueRoute(tx, { conversation: await lockConversation(tx, conversationId), row, outcome: action.outcome, correlationId, now });
          effects.turns.push(conversationId);
          return { kind: 'idle' };
        } else if (action.type === 'NEW') {
          // Carried: what the customer wrote since routing started, except the "new" reply itself.
          const carried = await customerMessagesAfter(tx, conversationId, row.seqFrom, seq ?? undefined);
          const newId = await startNewConversation(tx, { conversation: await lockConversation(tx, conversationId), row, active, carried, correlationId, now });
          await tx.update(conversations).set({ lastProcessedSeq: sql`${conversations.lastSeq}` }).where(eq(conversations.id, conversationId));
          return { kind: 'moved', conversationId: newId };
        }
      }
      if (classify || session.phase === 'DONE') break;
      // A question (new, or asked again) went out: later messages were written before the customer saw it,
      // so they do not answer it — and it must stay the current question rather than be overtaken by them.
      if (asked) break;
    }
    // The in-flight marker: attempts count classifications issued for a CLASSIFY step (the next step resets it).
    if (classify) session = { ...session, attempts: Math.max(1, session.attempts) };
    const saved = await this.persist(tx, conv, row, session, pending, now, asked);
    if (!classify) return { kind: 'idle' };
    return { kind: 'classify', expected: saved, request: { conversationId, step: classify, transcript: await transcript(tx, conversationId, row.seqFrom), correlationId } };
  }

  /**
   * No queue the router names has an agent (both lost theirs after
   * activation). The conversation stays ROUTING, visible to the Leads the
   * router reaches, with a timeline entry; the sweep retries every minute and
   * every new customer message retries at once.
   */
  private async unroutable(tx: DbOrTx, conversationId: string, row: RoutingRow, active: ActiveRouter, queueId: string, retry: boolean, correlationId: string, now: Date): Promise<void> {
    this.deps.onError?.(new Error('no queue with an agent to route to'), { conversationId, routerId: active.router.id, queueId, retry });
    if (retry) return;
    await appendSystemEvent(
      tx,
      conversationId,
      'system.routing_blocked',
      `Routing is waiting: neither the chosen queue nor the fallback of ${active.router.name} has an AI agent. Give one of them an agent; routing retries every minute.`,
      { routerId: active.router.id, routerVersionId: row.routerVersionId, queueId, fallbackQueueId: active.definition.fallbackQueueId },
      correlationId,
      now,
    );
  }

  /**
   * Save the session and mark every pending customer message consumed by the
   * router. `awaiting_since` restarts whenever a question went out (the
   * timeout measures silence since the last question). Returns the row's new updated_at.
   */
  private async persist(tx: DbOrTx, conv: ConversationRow, row: RoutingRow, session: RoutingSession, pending: ReadonlyArray<{ seq: number }>, now: Date, asked: boolean): Promise<Date> {
    await tx.update(conversationRouting).set(sessionColumns(session, asked ? null : row.awaitingSince, now)).where(eq(conversationRouting.conversationId, conv.id));
    const through = pending.at(-1)?.seq;
    if (through !== undefined && through > conv.lastProcessedSeq) await tx.update(conversations).set({ lastProcessedSeq: through }).where(eq(conversations.id, conv.id));
    return now;
  }
}

/** A short, content-free code for a classifier failure. */
export function classifierErrorCode(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && /^[a-z0-9_.:-]{1,60}$/i.test(code) ? code : 'classifier_error';
}
