import type { Permission, Principal } from '@ocso/auth';
import type { approvalProposals, Db, DbOrTx } from '@ocso/db';
import type { ApprovalAction } from '@ocso/domain';
import type { z } from 'zod';
import type { ActorContext } from '../shared/context.js';

/**
 * How one kind of configuration object takes part in maker–checker
 * (PM/research/11 §4, 11b). Each area registers a descriptor for the objects it
 * owns; the spine never switches on a kind. Every method that takes `tx` runs
 * inside the caller's transaction.
 */
export type ProposalRow = typeof approvalProposals.$inferSelect;

/** DONE: applied in the approval's transaction. DEFERRED: finished by the worker (provider calls, emails). */
export type ApprovalActivation = { kind: 'DONE' } | { kind: 'DEFERRED' };

export interface ApprovalProblem {
  code: string;
  message: string;
  /** A soft problem is shown to the checker but does not refuse the submit (it still blocks at activation). */
  soft?: boolean | undefined;
}

export interface ApprovalDescriptor {
  /** 'agent', 'queue', 'router', 'permission_change', … — also the audit target_type. */
  readonly kind: string;
  /** Human label: 'Virtual agent'. */
  readonly label: string;
  readonly actions: readonly ApprovalAction[];
  /** The permission that lets someone propose this change (the same one that guards the object's write route). */
  makePermission(action: ApprovalAction): Permission;
  /**
   * Who may propose it, when one permission cannot say (identity: users.manage OR users.manage_team). Replaces
   * `can(principal, makePermission(action))` wherever the spine checks the maker; makePermission still names
   * the canonical one (route decorators, coverage). Default: holds makePermission(action).
   */
  mayMake?(principal: Principal, action: ApprovalAction): boolean;
  /** The approvals.check.* permission a checker must hold. */
  readonly checkPermission: Permission;
  /**
   * Also lets a maker bootstrap (self-approve, recorded) when nobody anywhere holds checkPermission — for a
   * kind whose makers do not hold its check permission (a sole Tech taking a channel live). Default: none.
   */
  readonly bootstrapPermission?: Permission | undefined;
  /** Projection keys a stop action may change without voiding an open proposal (left out of the content hash). */
  readonly hashExclude?: readonly string[] | undefined;
  /** Validates the payload of CREATE/UPDATE proposals. */
  readonly payload?: z.ZodType | undefined;
  /** Checker-visible projection of the live object; null when it does not exist. Never secrets. */
  project(tx: DbOrTx, objectId: string): Promise<Record<string, unknown> | null>;
  /** The same projection with the proposal applied; null for DELETE. */
  projectAfter(tx: DbOrTx, proposal: ProposalRow): Promise<Record<string, unknown> | null>;
  /**
   * Owning teams at submit (and on an edit); [] = platform-wide. `payload`, when given, is the proposal's: a change
   * that moves the object to another owner (a rule retargeted to another team's agent) names both owners' teams.
   */
  teamIds(tx: DbOrTx, objectId: string, payload?: Record<string, unknown>): Promise<string[]>;
  /** 'kind:id@<updated_at ISO>' for everything whose change invalidates the proposal. */
  dependencies(tx: DbOrTx, proposal: ProposalRow): Promise<string[]>;
  /** Visibility (ADR-026); throws exactly as the object's own service does (404 out of scope). */
  assertVisible(tx: DbOrTx, principal: Principal, objectId: string): Promise<void>;
  /**
   * Write scope for proposing a change (ADR-026: writes are scoped by owning team, which can be narrower than
   * reads — agents.read_all reads every agent but manages none). Default: assertVisible.
   */
  assertMakeable?(tx: DbOrTx, principal: Principal, objectId: string, action: ApprovalAction): Promise<void>;
  /**
   * What the content hash covers instead of the checker projection: stable identifiers, not display names, so
   * renaming a queue elsewhere does not void every open proposal that mentions it. Default: the projection.
   */
  hashBasis?(tx: DbOrTx, objectId: string): Promise<Record<string, unknown> | null>;
  /**
   * The advisory-lock key and row locks that serialize every writer of this object's configuration. Objects
   * that describe the same configuration share a key (a prompt version locks its agent). Taken at submit,
   * at decision and by the direct write paths' own row lock. Default: `<kind>:<id>`, no row lock.
   */
  lock?(tx: DbOrTx, objectId: string): Promise<void>;
  /**
   * Other objects whose open (or activating) proposal also locks this one: an agent and its prompt versions
   * describe one configuration, so a proposal on either locks both. Default: none.
   */
  related?(tx: DbOrTx, objectId: string): Promise<ReadonlyArray<{ kind: string; objectIds: readonly string[] }>>;
  /**
   * Whether this user may check the proposal (beyond holding checkPermission, being ACTIVE and not the maker,
   * which the spine enforces). Default when omitted: platform-wide proposals accept any holder; team-scoped ones
   * need an overlapping team.
   */
  eligible?(tx: DbOrTx, checker: { userId: string; teamIds: readonly string[]; permissions: ReadonlySet<Permission> }, proposal: ProposalRow): Promise<boolean>;
  /**
   * Whether this write must go through a proposal. Default: once the object has been approved, every
   * change; before that, only ACTIVATE and DELETE (drafts are freely editable and inert). A kind whose
   * activation is gated by another object's approval (a prompt version by its agent's) overrides it.
   */
  requiresApproval?(tx: DbOrTx, objectId: string, action: ApprovalAction): Promise<boolean>;
  /** Business validation at submit, at render and again inside the activation transaction. */
  validate(tx: DbOrTx, proposal: ProposalRow): Promise<readonly ApprovalProblem[]>;
  /** Applies the change; writes the object's own audit row and bumps its cache generation. */
  activate(tx: DbOrTx, actor: ActorContext, proposal: ProposalRow): Promise<ApprovalActivation>;
  /**
   * Only when activate returns DEFERRED: runs in the worker, outside any transaction, after validation
   * and both hashes are re-checked — so `activate` must not change anything `project` returns.
   */
  activateDeferred?(db: Db, actor: ActorContext, proposal: ProposalRow): Promise<void>;
  /**
   * Only with DEFERRED: whether the approved change is already in effect — committed by `activate` (a new user is
   * active; the invite is a follow-up) or by an earlier activateDeferred that crashed before the spine stamped it (a
   * rule already deleted). The worker then skips re-validation and the hash checks, runs activateDeferred as an
   * idempotent follow-up and stamps the proposal ACTIVATED — a failing follow-up is recorded on that decision, never
   * turned into BLOCKED, because nothing live may carry a blocked approval. Default: false.
   */
  settled?(db: DbOrTx, proposal: ProposalRow): Promise<boolean>;
  /** Live objects of this kind (for the exception report's live-without-approval check). */
  liveObjects(tx: DbOrTx): Promise<string[]>;
  /** Queue row + email subject: "Take Maya live". */
  title(proposal: ProposalRow, before: Record<string, unknown> | null): string;
}
