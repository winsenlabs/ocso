import type { ModelGateway } from '@ocso/agent-runtime';
import type { ScriptStep } from '@ocso/agent-runtime/testing';
import type { Principal, Role } from '@ocso/auth';
import { internalAgentActions, type Db } from '@ocso/db';
import { eq } from 'drizzle-orm';
import { EXECUTE_TOOL, GET_TOOLS, InternalAgentService, type AgentSink, type AskOcsoTools, type InternalActionService, type ToolOutcome } from '../src/index.js';
import type { ActionCard } from '../src/runtime/types.js';
import { resolveRefs } from './refs.js';
import { cardProblems, scoreScenario, type RecordedCall, type SequenceStep } from './score.js';
import type { EvalScenario, ScenarioResult } from './types.js';
import type { WorldIds } from './world.js';

/**
 * Runs scenarios through the real Ask OCSO loop (InternalAgentService → the two meta tools → the real API
 * routes as the user). Two modes share every check:
 *
 * - `replay` (CI): the scripted model plays the scenario's expected calls, then its attacks. What is tested
 *   is the plumbing: permission filtering and refusals, card building, nothing running without a click,
 *   confirms, and the get_tools ranking for the scenario's search words.
 * - `model` (on demand): a real model answers the user's message on its own; the same checks score it.
 */
export type EvalMode = 'replay' | 'model';

/** What the API test support gives the runner (apps/api/test/int/ask-ocso-world.ts builds it). */
export interface EvalHarness {
  db: Db;
  ids: WorldIds;
  tools: AskOcsoTools;
  actions: InternalActionService;
  /** A gateway whose deployment Ask OCSO profile is the model under test (or the scripted one). */
  gateway: ModelGateway;
  /** The scripted adapter's script, set before each replayed scenario (replay mode only). */
  setScript?(steps: ScriptStep[]): void;
  /** The principal exactly as the auth guard builds it for the world user of this role. */
  principal(role: Role): Promise<Principal>;
  /** A digest per table of everything a write could change (agents, users, settings, approvals, conversations…). */
  fingerprint(): Promise<Record<string, string>>;
  /** The askOcsoWrites kill switch. */
  setWrites(on: boolean): Promise<void>;
  /** Reset per-user limits between scenarios (the 10-cards-a-minute limit). */
  beforeScenario?(): Promise<void>;
}

/** The tools the loop uses, recording every call and what it produced. */
function recording(tools: AskOcsoTools, calls: RecordedCall[]): AskOcsoTools {
  return {
    specs: () => tools.specs(),
    run: async (principal: Principal, call: Parameters<AskOcsoTools['run']>[1], toolName: string, input: unknown): Promise<ToolOutcome> => {
      const outcome = await tools.run(principal, call, toolName, input);
      calls.push({ toolName, input, outcome });
      return outcome;
    },
  } as unknown as AskOcsoTools;
}

const execute = (name: string, args: Record<string, unknown>): ScriptStep => ({ toolCalls: [{ toolName: EXECUTE_TOOL, input: { name, args } }] });

/** The scripted model's turn: search, the expected calls, the attacks, then a short answer. */
export function replayScript(s: EvalScenario, ids: WorldIds): ScriptStep[] {
  const steps: ScriptStep[] = [];
  if (s.purpose) steps.push({ toolCalls: [{ toolName: GET_TOOLS, input: { purpose: s.purpose, limit: 8 } }] });
  for (const c of s.calls) steps.push(execute(c.tool, resolveRefs({ ...(c.args ?? {}), ...(c.replayArgs ?? {}) }, ids)));
  for (const a of s.attacks ?? []) steps.push(execute(a.tool, resolveRefs(a.args, ids)));
  steps.push({ text: s.expect.type === 'card' ? 'I made a card: nothing changes until you confirm it.' : s.expect.type === 'clarify' ? 'Which one do you mean?' : 'Here is what I found.' });
  return steps;
}

/**
 * The scripted model's turn `turn` of a sequence: the search on the first turn, that turn's call (its `@created.<i>`
 * refs filled from earlier confirms), the attacks on the last turn, then a short answer.
 */
export function sequenceTurnScript(s: EvalScenario, turn: number, ids: Record<string, string>): ScriptStep[] {
  const steps: ScriptStep[] = [];
  const call = s.calls[turn];
  if (turn === 0 && s.purpose) steps.push({ toolCalls: [{ toolName: GET_TOOLS, input: { purpose: s.purpose, limit: 8 } }] });
  if (call) steps.push(execute(call.tool, resolveRefs({ ...(call.args ?? {}), ...(call.replayArgs ?? {}) }, ids as WorldIds)));
  if (turn === s.calls.length - 1) for (const a of s.attacks ?? []) steps.push(execute(a.tool, resolveRefs(a.args, ids as WorldIds)));
  steps.push({ text: 'I made a card: nothing changes until you confirm it.' });
  return steps;
}

/** How many recorded calls belong to the expected part of a replay (the rest are attacks). */
export function expectedCallCount(s: EvalScenario): number {
  return (s.purpose ? 1 : 0) + s.calls.length;
}

export async function runScenario(h: EvalHarness, s: EvalScenario, mode: EvalMode): Promise<ScenarioResult> {
  if (s.expect.type === 'sequence') return runSequence(h, s, mode);
  const started = Date.now();
  await h.beforeScenario?.();
  if (s.setup?.writesOff) await h.setWrites(false);
  const calls: RecordedCall[] = [];
  const cards: ActionCard[] = [];
  let reply = '';
  let loopError: string | null = null;
  let confirmed: ActionCard | null = null;
  let changedAfterConfirm: string[] | null = null;
  const principal = await h.principal(s.role);
  const before = await h.fingerprint();
  let after = before;
  try {
    if (mode === 'replay') {
      if (!h.setScript) throw new Error('replay mode needs the scripted adapter (setScript)');
      h.setScript(replayScript(s, h.ids));
    }
    const sink: AgentSink = {
      text: (d) => (reply += d),
      step: () => {},
      links: () => {},
      table: () => {},
      card: (c) => cards.push(c),
      denied: () => {},
    };
    const agent = new InternalAgentService(h.db, h.gateway, recording(h.tools, calls), h.actions);
    const page = s.page ? resolveRefs(s.page, h.ids) : null;
    try {
      await agent.ask(principal, null, s.message, sink, `eval-${s.id}-${started}`, undefined, page);
    } catch (err) {
      loopError = (err as Error).message;
    }
    after = await h.fingerprint();

    // Confirm the scenario's own card when it asks to, as the user would (a governed one to the named checker).
    const plan = s.expect.type === 'card' ? s.expect.card.confirm : undefined;
    // The first card for the target tool (in a replay, attacks come after the expected calls).
    const card = s.expect.type === 'card' ? cards.find((c) => c.tool === (s.expect as { card: { tool: string } }).card.tool) : undefined;
    // A real model's card is confirmed only when it is the right one: a wrong card must never change the world.
    const right = card && s.expect.type === 'card' && (mode === 'replay' || cardProblems(card, s.expect.card, h.ids).length === 0);
    if (plan && card && right && card.status === 'PENDING') {
      const checkerId = plan.checker ? resolveRefs(plan.checker, h.ids) : card.approval?.checkers.find((c) => c.suggested)?.id;
      try {
        const typed = plan.credentials ? { credentials: plan.credentials } : {};
        confirmed = await h.actions.confirm(principal, card.id, card.kind === 'governed' ? { checkerId, reason: plan.reason ?? 'Evaluation: requested in Ask OCSO', ...typed } : typed, `eval-confirm-${s.id}`);
      } catch (err) {
        confirmed = { ...card, status: 'FAILED', result: { message: (err as Error).message } };
      }
      changedAfterConfirm = changedTables(after, await h.fingerprint());
    }
  } finally {
    if (s.setup?.writesOff) await h.setWrites(true);
  }
  return scoreScenario(s, mode, {
    principal,
    ids: h.ids,
    calls,
    cards,
    reply,
    loopError,
    changed: changedTables(before, after),
    confirmed,
    changedAfterConfirm,
    ms: Date.now() - started,
  });
}

/** What a confirmed card created: the id its route answered (kept in the action row's stored result). */
async function createdId(db: Db, cardId: string): Promise<string | null> {
  const [row] = await db.select({ result: internalAgentActions.result }).from(internalAgentActions).where(eq(internalAgentActions.id, cardId));
  const id = (row?.result as { data?: { id?: unknown } } | null)?.data?.id;
  return typeof id === 'string' ? id : null;
}

/**
 * A sequence scenario: one thread, one turn per expected card. Each turn's card is confirmed as the user would
 * (a governed one to the named checker) before the next turn, so later calls can use what earlier ones created.
 */
async function runSequence(h: EvalHarness, s: EvalScenario, mode: EvalMode): Promise<ScenarioResult> {
  if (s.expect.type !== 'sequence') throw new Error('sequence scenario');
  const expected = s.expect.cards;
  const followUps = s.expect.followUps ?? [];
  const started = Date.now();
  await h.beforeScenario?.();
  const calls: RecordedCall[] = [];
  const cards: ActionCard[] = [];
  const steps: SequenceStep[] = [];
  const changed = new Set<string>();
  const ids: Record<string, string> = { ...h.ids };
  let reply = '';
  let loopError: string | null = null;
  let threadId: string | null = null;
  const principal = await h.principal(s.role);
  const sink: AgentSink = { text: (d) => (reply += d), step: () => {}, links: () => {}, table: () => {}, card: (c) => cards.push(c), denied: () => {} };
  const agent = new InternalAgentService(h.db, h.gateway, recording(h.tools, calls), h.actions);
  const page = s.page ? resolveRefs(s.page, h.ids) : null;
  for (const [turn, want] of expected.entries()) {
    const seen = cards.length;
    const before = await h.fingerprint();
    if (mode === 'replay') {
      if (!h.setScript) throw new Error('replay mode needs the scripted adapter (setScript)');
      h.setScript(sequenceTurnScript(s, turn, ids));
    }
    const message = turn === 0 ? s.message : (followUps[turn - 1] ?? 'Confirmed. Go on with the next step.');
    try {
      threadId = (await agent.ask(principal, threadId, message, sink, `eval-${s.id}-${turn}-${started}`, undefined, page)).threadId;
    } catch (err) {
      loopError = (err as Error).message;
    }
    const after = await h.fingerprint();
    for (const t of changedTables(before, after)) changed.add(t);
    const card = cards.slice(seen).find((c) => c.tool === want.tool) ?? null;
    const right = card && (mode === 'replay' || cardProblems(card, want, h.ids).length === 0);
    let confirmed: ActionCard | null = null;
    let changedAfterConfirm: string[] | null = null;
    if (want.confirm && card && right && card.status === 'PENDING') {
      const checkerId = want.confirm.checker ? resolveRefs(want.confirm.checker, h.ids) : card.approval?.checkers.find((c) => c.suggested)?.id;
      try {
        const typed = want.confirm.credentials ? { credentials: want.confirm.credentials } : {};
        confirmed = await h.actions.confirm(principal, card.id, card.kind === 'governed' ? { checkerId, reason: want.confirm.reason ?? 'Evaluation: requested in Ask OCSO', ...typed } : typed, `eval-confirm-${s.id}-${turn}`);
      } catch (err) {
        confirmed = { ...card, status: 'FAILED', result: { message: (err as Error).message } };
      }
      changedAfterConfirm = changedTables(after, await h.fingerprint());
      const id = confirmed.status === 'EXECUTED' ? await createdId(h.db, card.id) : null;
      if (id) ids[`created.${turn}`] = id;
    }
    steps.push({ card, confirmed, changedAfterConfirm });
    if (loopError || !confirmed || (confirmed.status !== 'EXECUTED' && confirmed.status !== 'SUBMITTED')) break;
  }
  return scoreScenario(s, mode, {
    principal,
    ids: ids as WorldIds,
    calls,
    cards,
    reply,
    loopError,
    changed: [...changed].sort(),
    confirmed: steps.at(-1)?.confirmed ?? null,
    changedAfterConfirm: steps.at(-1)?.changedAfterConfirm ?? null,
    steps,
    ms: Date.now() - started,
  });
}

/** Tables whose digest differs between two fingerprints. */
export function changedTables(a: Record<string, string>, b: Record<string, string>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((t) => a[t] !== b[t]).sort();
}

/** Run every scenario in order (they share one world). */
export async function runScenarios(h: EvalHarness, scenarios: readonly EvalScenario[], mode: EvalMode, onResult?: (r: ScenarioResult) => void): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    const r = await runScenario(h, s, mode);
    results.push(r);
    onResult?.(r);
  }
  return results;
}
