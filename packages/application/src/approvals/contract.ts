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
}

export interface ApprovalDescriptor {
  /** 'agent', 'queue', 'router', 'permission_change', … — also the audit target_type. */
  readonly kind: string;
  /** Human label: 'Virtual agent'. */
  readonly label: string;
  readonly actions: readonly ApprovalAction[];
  /** The permission that lets someone propose this change (the same one that guards the object's write route). */
  makePermission(action: ApprovalAction): Permission;
  /** The approvals.check.* permission a checker must hold. */
  readonly checkPermission: Permission;
  /** Validates the payload of CREATE/UPDATE proposals. */
  readonly payload?: z.ZodType | undefined;
  /** Checker-visible projection of the live object; null when it does not exist. Never secrets. */
  project(tx: DbOrTx, objectId: string): Promise<Record<string, unknown> | null>;
  /** The same projection with the proposal applied; null for DELETE. */
  projectAfter(tx: DbOrTx, proposal: ProposalRow): Promise<Record<string, unknown> | null>;
  /** Owning teams at submit; [] = platform-wide. */
  teamIds(tx: DbOrTx, objectId: string): Promise<string[]>;
  /** 'kind:id@<updated_at ISO>' for everything whose change invalidates the proposal. */
  dependencies(tx: DbOrTx, proposal: ProposalRow): Promise<string[]>;
  /** Visibility (ADR-026); throws exactly as the object's own service does (404 out of scope). */
  assertVisible(tx: DbOrTx, principal: Principal, objectId: string): Promise<void>;
  /**
   * Whether this user may check the proposal (beyond holding checkPermission, being ACTIVE and not the maker,
   * which the spine enforces). Default when omitted: platform-wide proposals accept any holder; team-scoped ones
   * need an overlapping team.
   */
  eligible?(tx: DbOrTx, checker: { userId: string; teamIds: readonly string[]; permissions: ReadonlySet<Permission> }, proposal: ProposalRow): Promise<boolean>;
  /** Business validation at submit, at render and again inside the activation transaction. */
  validate(tx: DbOrTx, proposal: ProposalRow): Promise<readonly ApprovalProblem[]>;
  /** Applies the change; writes the object's own audit row and bumps its cache generation. */
  activate(tx: DbOrTx, actor: ActorContext, proposal: ProposalRow): Promise<ApprovalActivation>;
  /** Only when activate returns DEFERRED: runs in the worker, outside any transaction. */
  activateDeferred?(db: Db, actor: ActorContext, proposal: ProposalRow): Promise<void>;
  /** Live objects of this kind (for the exception report's live-without-approval check). */
  liveObjects(tx: DbOrTx): Promise<string[]>;
  /** Queue row + email subject: "Take Maya live". */
  title(proposal: ProposalRow, before: Record<string, unknown> | null): string;
}
