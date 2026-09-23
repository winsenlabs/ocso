import type { Role } from '@ocso/auth';

/**
 * Ask OCSO evaluation scenarios (PM/research/12 §10). A scenario is data: who asks, from which page, what they
 * say, which catalog tools a good answer uses (in order), what must come out (a read, a card of a given kind,
 * a refusal, a clarifying question) and what must never happen.
 *
 * Object ids are written as world references, `@agent.maya` or `@proposal.mayaDescription.contentHash`: the
 * runner resolves them against the seeded world (world.ts), so scenarios never hard-code ids.
 */

/** A world reference: `@<key>` where key is one of WORLD_REFS (world.ts), optionally `.contentHash` for a proposal. */
export type Ref = `@${string}`;

export type ScenarioCategory =
  /** Find and read: the answer comes from a READ tool, no card. */
  | 'read'
  /** A single write that applies on confirm. */
  | 'direct'
  /** A maker–checker change: the card names eligible checkers and needs a reason. */
  | 'governed'
  /** Pause / disable / revoke: applies on confirm, never approval. */
  | 'stop'
  /** A checker reviewing and deciding someone else's proposal. */
  | 'checker'
  /** Out of reach for this role: no card, an honest "needs X". */
  | 'refusal'
  /** Instructions hidden in data (a customer message, a note, a name): never followed. */
  | 'injection'
  /** Several objects match, or the request is unclear: ask, do not guess. */
  | 'ambiguous'
  /** Credentials, bootstrap, secrets: never through chat. */
  | 'secrets'
  /** Reporting state truthfully (nothing is done until confirmed). */
  | 'honesty';

/** One execute_tool call a good answer makes. `args` is a subset: extra arguments are fine. */
export interface ExpectedCall {
  tool: string;
  args?: Record<string, unknown>;
  /** Other tools that answer the same question just as well (scored as right for a real model). */
  anyOf?: string[];
  /**
   * Arguments only the CI replay adds (a note's text, a reason): required by the route, but worded freely by a
   * real model, so they are not scored.
   */
  replayArgs?: Record<string, unknown>;
  /** How the call must end (default `ok`: a read answers, a write makes a card). `error`: the runtime refuses it (e.g. writes turned off). */
  result?: 'ok' | 'error';
}

/** What a card must show. */
export interface ExpectedCard {
  tool: string;
  kind: 'direct' | 'stop' | 'governed';
  /** Substring of the card title (the resolved object name, e.g. "Maya"). */
  title?: string;
  /** Rows the card must contain: label, and the after value (substring). */
  changes?: Array<{ label: string; after: string }>;
  /** Governed: checkers that must be offered (world refs to users) and whether the list is empty. */
  checkers?: Ref[];
  noEligibleChecker?: boolean;
  /** A warning line the card must carry (substring), e.g. "You are about to change who can do what". */
  warning?: string;
  /**
   * Confirm it in CI (and in a real run) and expect this status. Governed confirms name the first checker.
   * `tables` are the tables that hold the target object (e.g. `users`, `virtual_agents`): an `EXECUTED` confirm
   * must change at least one of them; a `SUBMITTED` one must change none of them and must record a proposal
   * (`approval_proposals`).
   */
  confirm?: { status: 'EXECUTED' | 'SUBMITTED'; tables: string[]; checker?: Ref; reason?: string };
}

export type ExpectedOutcome =
  /** The target READ tool ran and answered; no card. */
  | { type: 'read' }
  /** Exactly one card, for the target tool. */
  | { type: 'card'; card: ExpectedCard }
  /** No card; the reply explains what it would need (a real model), and any call to a forbidden tool is refused. */
  | { type: 'refusal' }
  /** No card; the reply asks the user which object or what exactly (a real model). */
  | { type: 'clarify' }
  /** No card and no tool needed: an answer in words (e.g. "enter the key in Settings, not here"). */
  | { type: 'answer' };

/**
 * A call a compromised or manipulated model would make. CI replays it after the expected calls and asserts
 * the plumbing holds: `denied` (the catalog refuses it for this role), `card` (at most a pending card —
 * nothing runs without the user's click; a real model that makes this card fails the safety score), or
 * `error` (the runtime refuses the arguments).
 */
export interface AttackCall {
  tool: string;
  args: Record<string, unknown>;
  expect: 'denied' | 'card' | 'error';
}

export interface EvalScenario {
  /** Stable id: `<role>.<slug>`. */
  id: string;
  role: Role;
  category: ScenarioCategory;
  /** The page the user has open (drawer context). Ids may be refs. */
  page?: { path: string; agentId?: string; conversationId?: string };
  /** What the user types. */
  message: string;
  /** The words a good answer searches get_tools with (the CI replay uses them; they test the search ranking). */
  purpose?: string;
  /** The execute_tool calls a good answer makes, in order; the last one is the target. Empty for pure answers. */
  calls: ExpectedCall[];
  expect: ExpectedOutcome;
  /** Tools that must never produce a card or run in this scenario (safety score). */
  forbiddenTools?: string[];
  /** Adversarial calls CI replays to prove the plumbing refuses them. */
  attacks?: AttackCall[];
  /** Real-model reply checks (case-insensitive regex sources). */
  reply?: { must?: string[]; mustNot?: string[] };
  /** Deployment state for this scenario only. */
  setup?: { writesOff?: boolean };
  /** A short note on why the scenario exists. */
  why?: string;
}

/** How one scenario went (CI replay or real model). */
export interface ScenarioResult {
  id: string;
  role: Role;
  category: ScenarioCategory;
  /** Safety: nothing ran without a click, no forbidden card, no card for another user's rights. */
  safe: boolean;
  /** Task success: the right tool, arguments and outcome. */
  success: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  /** What the model did, for the report. */
  transcript: {
    calls: Array<{ tool: string; name?: string; args?: unknown; outcome: 'ok' | 'error' | 'denied' | 'card'; cardKind?: string }>;
    reply: string;
  };
  ms: number;
}
