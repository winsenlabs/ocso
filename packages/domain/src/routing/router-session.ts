import { isPassThrough, type ClassifyStep, type MessageSpec, type RouterDefinition } from './router-definition.js';
import { RETURNING_STEP, choiceId, describeRule, evaluateRules, matchOption, matchReturning, type RouterReply } from './router-match.js';

/**
 * The router as a pure state machine (PM/research/11 §5.3). The engine (and
 * the simulator) feed it events and carry out its actions: send a message,
 * ask the model to classify, decide a queue, continue or start anew. Keeping
 * it pure means the simulate panel shows exactly what production would do.
 */

export type RoutingPhase = 'RETURNING' | 'STEPS' | 'DONE';
export type DecideOutcome = 'RULE' | 'MODEL' | 'FALLBACK' | 'PASS_THROUGH' | 'TIMEOUT';

export interface RoutingSession {
  phase: RoutingPhase;
  stepIndex: number;
  attributes: Record<string, string>;
  /** Step id → the option value the customer chose. */
  answers: Record<string, string>;
  /** `error`: the classifier failed (an outage, not low confidence); the step moved on unset. */
  classifications: Record<string, { label: string | null; confidence: number; error?: string }>;
  followUps: number;
  /** Prompts sent for the current step (or the returning prompt). */
  attempts: number;
  /** The router asked something and waits for the customer's reply. */
  awaiting: boolean;
}

export interface Classification {
  label: string | null;
  confidence: number;
  followUp: string | null;
  /** Set when the classifier failed; the router treats it as unclassified. */
  error?: string | undefined;
}

export type RoutingEvent =
  | { type: 'START' }
  | { type: 'REPLY'; reply: RouterReply }
  | { type: 'CLASSIFIED'; stepId: string; result: Classification }
  | { type: 'TIMEOUT' };

export type RoutingAction =
  | { type: 'SEND'; stepId: string; message: MessageSpec; options: Array<{ id: string; label: string }> | null }
  | { type: 'CLASSIFY'; step: ClassifyStep }
  | { type: 'DECIDE'; queueId: string; outcome: DecideOutcome; ruleIndex: number | null; reason: string }
  | { type: 'CONTINUE'; outcome: 'CONTINUE' | 'TIMEOUT' }
  | { type: 'NEW' };

export interface SessionContext {
  /** Values for KNOWN steps (`customer.language`, `customer.attribute:<key>`); null when unknown. */
  known(from: string): string | null;
}

/** Returning prompts before the router gives up and continues the old conversation. */
export const RETURNING_MAX_PROMPTS = 2;

export function newSession(phase: 'RETURNING' | 'STEPS'): RoutingSession {
  return { phase, stepIndex: 0, attributes: {}, answers: {}, classifications: {}, followUps: 0, attempts: 0, awaiting: false };
}

function nextStep(s: RoutingSession): void {
  s.stepIndex++;
  s.attempts = 0;
  s.followUps = 0;
  s.awaiting = false;
}

function decide(def: RouterDefinition, s: RoutingSession, timeout: boolean): RoutingAction {
  s.phase = 'DONE';
  s.awaiting = false;
  if (timeout) return { type: 'DECIDE', queueId: def.fallbackQueueId, outcome: 'TIMEOUT', ruleIndex: null, reason: 'no answer in time · fallback' };
  const hit = evaluateRules(def.rules, s.attributes);
  if (hit) {
    const modelKeys = new Set(def.steps.flatMap((step) => (step.kind === 'CLASSIFY' && s.classifications[step.id] ? [step.attribute] : [])));
    const byModel = Object.keys(hit.rule.when).some((k) => modelKeys.has(k));
    return { type: 'DECIDE', queueId: hit.rule.queueId, outcome: byModel ? 'MODEL' : 'RULE', ruleIndex: hit.index, reason: `rule ${hit.index + 1}: ${describeRule(hit.rule)}` };
  }
  return isPassThrough(def)
    ? { type: 'DECIDE', queueId: def.fallbackQueueId, outcome: 'PASS_THROUGH', ruleIndex: null, reason: 'pass-through' }
    : { type: 'DECIDE', queueId: def.fallbackQueueId, outcome: 'FALLBACK', ruleIndex: null, reason: 'no rule matched · fallback' };
}

function returningStep(def: RouterDefinition, s: RoutingSession, event: RoutingEvent, actions: RoutingAction[]): void {
  const returning = def.returning;
  const send = () =>
    actions.push({
      type: 'SEND',
      stepId: RETURNING_STEP,
      message: returning!.prompt,
      options: [
        { id: choiceId(RETURNING_STEP, 'continue'), label: returning!.continueLabel },
        { id: choiceId(RETURNING_STEP, 'new'), label: returning!.newLabel },
      ],
    });
  const done = () => {
    s.phase = 'DONE';
    s.awaiting = false;
    actions.push({ type: 'CONTINUE', outcome: 'CONTINUE' });
  };
  if (!returning) return done();
  if (!s.awaiting) {
    s.attempts = 1;
    s.awaiting = true;
    return void send();
  }
  if (event.type !== 'REPLY') return;
  const choice = matchReturning(returning, event.reply);
  if (choice === 'continue') return done();
  if (choice === 'new') {
    Object.assign(s, newSession('STEPS'));
    return void actions.push({ type: 'NEW' });
  }
  if (s.attempts >= RETURNING_MAX_PROMPTS) return done();
  s.attempts++;
  send();
}

/**
 * One event through the router. Returns the new session (the input is not
 * mutated) and the actions to carry out, in order. A REPLY is consumed by the
 * step waiting for it; START (re)starts a step that is not waiting.
 */
export function advanceSession(def: RouterDefinition, input: RoutingSession, event: RoutingEvent, ctx: SessionContext): { session: RoutingSession; actions: RoutingAction[] } {
  const s: RoutingSession = { ...input, attributes: { ...input.attributes }, answers: { ...input.answers }, classifications: { ...input.classifications } };
  const actions: RoutingAction[] = [];
  if (s.phase === 'DONE') return { session: s, actions };
  if (event.type === 'TIMEOUT') {
    if (s.phase === 'RETURNING') {
      s.phase = 'DONE';
      s.awaiting = false;
      actions.push({ type: 'CONTINUE', outcome: 'TIMEOUT' });
    } else actions.push(decide(def, s, true));
    return { session: s, actions };
  }
  if (s.phase === 'RETURNING') {
    returningStep(def, s, event, actions);
    return { session: s, actions };
  }

  let pending: RoutingEvent | null = event;
  while (s.stepIndex < def.steps.length) {
    const step = def.steps[s.stepIndex]!;
    if (step.kind === 'KNOWN') {
      const value = ctx.known(step.from);
      if (value) s.attributes[step.attribute] = value;
      nextStep(s);
      continue;
    }
    if (!s.awaiting && s.attempts === 0 && step.skipIfKnown && s.attributes[step.attribute] !== undefined) {
      nextStep(s);
      continue;
    }
    if (step.kind === 'ASK') {
      const options = step.options.map((o) => ({ id: choiceId(step.id, o.value), label: o.label }));
      if (s.awaiting) {
        if (pending?.type !== 'REPLY') break;
        const hit = matchOption(step.id, step.options, pending.reply);
        pending = null;
        if (hit) {
          s.attributes[step.attribute] = hit.value;
          s.answers[step.id] = hit.value;
          nextStep(s);
          continue;
        }
        if (s.attempts < step.maxAttempts) {
          s.attempts++;
          actions.push({ type: 'SEND', stepId: step.id, message: step.prompt, options });
          break;
        }
        nextStep(s);
        continue;
      }
      s.attempts = 1;
      s.awaiting = true;
      actions.push({ type: 'SEND', stepId: step.id, message: step.prompt, options });
      break;
    }
    // CLASSIFY
    if (pending?.type === 'CLASSIFIED' && pending.stepId === step.id) {
      const result = pending.result;
      pending = null;
      const label = result.label ? step.labels.find((l) => l.value.toLowerCase() === result.label!.toLowerCase()) : undefined;
      s.classifications[step.id] = { label: label?.value ?? null, confidence: result.confidence, ...(result.error ? { error: result.error } : {}) };
      if (label && result.confidence >= step.minConfidence) {
        s.attributes[step.attribute] = label.value;
        nextStep(s);
        continue;
      }
      if (result.followUp?.trim() && s.followUps < step.maxFollowUps) {
        s.followUps++;
        s.awaiting = true;
        actions.push({ type: 'SEND', stepId: step.id, message: { text: result.followUp.trim().slice(0, 1_000) }, options: null });
        break;
      }
      nextStep(s);
      continue;
    }
    if (s.awaiting && pending?.type !== 'REPLY') break;
    s.awaiting = false;
    actions.push({ type: 'CLASSIFY', step });
    break;
  }
  if (s.stepIndex >= def.steps.length) actions.push(decide(def, s, false));
  return { session: s, actions };
}
