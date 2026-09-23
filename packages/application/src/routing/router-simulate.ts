import { eq, inArray } from 'drizzle-orm';
import { advanceSession, newSession, type Classification, type RouterDefinition, type RoutingEvent, type RoutingSession } from '@ocso/domain';
import { queues, virtualAgents, type DbOrTx } from '@ocso/db';
import { z } from 'zod';
import { classifierErrorCode, type RouterClassifier } from './routing-engine.js';

export const RouterSimulateInput = z.object({
  /** The customer's messages in order: the first opens the conversation, the rest answer the router. */
  messages: z.array(z.string().trim().min(1).max(4_000)).min(1).max(20),
  /** CLASSIFY step id → the label to assume instead of calling the model. */
  answers: z.record(z.string().max(40), z.string().max(60)).default({}),
  /** Simulate a version instead of the draft. */
  versionId: z.uuid().optional(),
  /** Start at the returning-customer question. */
  returning: z.boolean().default(false),
  /** Customer facts for KNOWN steps. */
  customer: z.object({ language: z.string().max(20).optional(), attributes: z.record(z.string(), z.string().max(200)).default({}) }).default({ attributes: {} }),
});
export type RouterSimulateInput = z.infer<typeof RouterSimulateInput>;

export type SimulationTrace =
  | { kind: 'customer'; text: string }
  | { kind: 'router'; stepId: string; text: string; options: Array<{ id: string; label: string }> | null }
  | { kind: 'classified'; stepId: string; label: string | null; confidence: number; followUp: string | null; source: 'answer' | 'model' | 'none' | 'error'; error?: string | undefined }
  | { kind: 'decided'; queueId: string; queueName: string | null; agentName: string | null; outcome: string; ruleIndex: number | null; reason: string }
  | { kind: 'continued'; outcome: string }
  | { kind: 'new_conversation' }
  | { kind: 'waiting'; text: string };

export interface SimulationResult {
  trace: SimulationTrace[];
  session: RoutingSession;
  decision: Extract<SimulationTrace, { kind: 'decided' }> | null;
}

/**
 * Dry run of a router definition (PM/research/11 §5.7 simulate panel): the
 * same pure state machine the engine runs, fed the given messages. Nothing is
 * written and nothing is sent; CLASSIFY uses `answers` when given, else the
 * model when a classifier is available (routers.manage only), else
 * "unclassified"; a classifier failure is reported as source `error`.
 */
export async function simulateRouter(db: DbOrTx, def: RouterDefinition, input: RouterSimulateInput, classifier: RouterClassifier | null): Promise<SimulationResult> {
  const trace: SimulationTrace[] = [];
  const transcript: Array<{ from: 'customer' | 'router'; text: string }> = [];
  const messages = [...input.messages];
  const ctx = {
    known(from: string) {
      if (from === 'customer.language') return input.customer.language?.trim() || null;
      return input.customer.attributes[from.replace(/^customer\.attribute:/, '')]?.trim() || null;
    },
  };
  const opening = messages.shift()!;
  trace.push({ kind: 'customer', text: opening });
  transcript.push({ from: 'customer', text: opening });
  let session = newSession(input.returning && def.returning ? 'RETURNING' : 'STEPS');
  let event: RoutingEvent | null = { type: 'START' };
  let decision: SimulationResult['decision'] = null;
  for (let guard = 0; event && guard < 60; guard++) {
    const result = advanceSession(def, session, event, ctx);
    session = result.session;
    event = null;
    for (const action of result.actions) {
      if (action.type === 'SEND') {
        trace.push({ kind: 'router', stepId: action.stepId, text: action.message.text, options: action.options });
        transcript.push({ from: 'router', text: action.message.text });
      } else if (action.type === 'CLASSIFY') {
        const pinned = input.answers[action.step.id];
        let classification: Classification = { label: null, confidence: 0, followUp: null };
        let source: 'answer' | 'model' | 'none' | 'error' = 'none';
        if (pinned !== undefined) {
          classification = { label: pinned, confidence: 1, followUp: null };
          source = 'answer';
        } else if (classifier) {
          try {
            classification = await classifier({ conversationId: 'simulation', step: action.step, transcript, correlationId: 'simulation' });
            source = 'model';
          } catch (err) {
            // An outage is not low confidence: say so (the live engine records the same code on the session).
            classification = { ...classification, error: classifierErrorCode(err) };
            source = 'error';
          }
        }
        trace.push({ kind: 'classified', stepId: action.step.id, ...classification, source });
        event = { type: 'CLASSIFIED', stepId: action.step.id, result: classification };
      } else if (action.type === 'DECIDE') {
        const [row] = await db.select({ name: queues.name, agentName: virtualAgents.name }).from(queues).leftJoin(virtualAgents, eq(virtualAgents.id, queues.agentId)).where(inArray(queues.id, [action.queueId]));
        decision = { kind: 'decided', queueId: action.queueId, queueName: row?.name ?? null, agentName: row?.agentName ?? null, outcome: action.outcome, ruleIndex: action.ruleIndex, reason: action.reason };
        trace.push(decision);
      } else if (action.type === 'CONTINUE') trace.push({ kind: 'continued', outcome: action.outcome });
      else if (action.type === 'NEW') {
        trace.push({ kind: 'new_conversation' });
        event = { type: 'START' };
      }
    }
    if (event || session.phase === 'DONE') continue;
    if (session.awaiting) {
      const next = messages.shift();
      if (next === undefined) {
        trace.push({ kind: 'waiting', text: `Waiting for the customer (after ${def.timeoutMinutes} min without an answer: the fallback queue)` });
        break;
      }
      trace.push({ kind: 'customer', text: next });
      transcript.push({ from: 'customer', text: next });
      event = { type: 'REPLY', reply: { text: next, choiceIds: [] } };
    }
  }
  return { trace, session, decision };
}
