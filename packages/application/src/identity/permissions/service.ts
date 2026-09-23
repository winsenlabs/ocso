import { inArray } from 'drizzle-orm';
import { Permission, applyRightsChange, assertCan, can, isEmptyRightsChange, planRightsChange, type RightsClassification } from '@ocso/auth';
import { DomainError, conflict, forbidden, notFound, validation } from '@ocso/domain';
import { users, type Db } from '@ocso/db';
import type { ActorContext } from '../../shared/context.js';
import { applyPermissionChangeSet, assertGrantsAllowed } from './apply.js';
import { PermissionChangeInput, toChangeSet, toRightsChange } from './change-set.js';
import { proposeIncrease, type IdentityGovernance, type IdentityProposalRef } from './gate.js';
import { assertMayChangeRights } from './makers.js';
import { loadUserRights } from './state.js';
import { permissionCatalogue, userPermissionsView, type CatalogueEntry, type UserPermissionsView } from './views.js';

/**
 * The reductions in a change apply at once (`applied`, 200); the widening part,
 * if any, becomes a proposal (202). Both can happen in one request.
 */
export interface PermissionChangeResult {
  /** Something changed now (the reductions, or the whole change when nothing widens access). */
  applied: boolean;
  /** Of the whole change: INCREASE when any part needs approval. */
  direction: 'INCREASE' | 'DECREASE' | 'NONE';
  /** What applied now. */
  appliedClassification: RightsClassification;
  sessionsEnded: number;
  /** What waits for approval (null when nothing does). */
  proposedClassification: RightsClassification | null;
  proposal: IdentityProposalRef | null;
}

/** Re-raise a 409 approval_required saying what already applied, so the client can tell the user. */
export function withAppliedPart(err: unknown, reduced: RightsClassification | null): unknown {
  if (!(err instanceof DomainError) || err.code !== 'approval_required' || !reduced || reduced.direction === 'NONE') return err;
  const lost = reduced.lost.length ? `removed ${reduced.lost.join(', ')}` : null;
  const left = reduced.teamsRemoved.length ? `left ${reduced.teamsRemoved.length} team(s)` : null;
  const what = [lost, left].filter(Boolean).join('; ') || 'the reductions';
  return new DomainError(err.category, err.code, `${err.message}. The reductions in this change were applied (${what}); the rest was not`, {
    ...err.details,
    applied: { lost: reduced.lost, teamsRemoved: reduced.teamsRemoved },
  });
}

/**
 * Per-user permissions (PM/research/11 §3.3–3.5): who holds what and why, and
 * changing it. Decreases apply at once; increases become a `permission_change`
 * proposal (or 409 approval_required).
 */
export class PermissionService {
  constructor(
    private readonly db: Db,
    private readonly governance: IdentityGovernance = {},
  ) {}

  catalogue(): CatalogueEntry[] {
    return permissionCatalogue();
  }

  /** permissions.read; the target must share a team with the reader unless they hold users.manage (else 404, ADR-026). */
  async forUser(actor: ActorContext, userId: string): Promise<UserPermissionsView> {
    const principal = actor.principal!;
    assertCan(principal, Permission.PERMISSIONS_READ);
    const rights = await loadUserRights(this.db, userId);
    const visible = can(principal, Permission.USERS_MANAGE) || userId === principal.userId || rights.teamIds.some((t) => principal.teamIds.includes(t));
    if (!visible) throw notFound('user', userId);
    const ids = [...new Set(rights.overrides.map((o) => o.createdBy).filter((id): id is string => id !== null))];
    const names = ids.length ? await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : [];
    return userPermissionsView(rights, new Map(names.map((n) => [n.id, n.name])));
  }

  /** POST /v1/users/:id/permission-changes. */
  async change(actor: ActorContext, userId: string, raw: PermissionChangeInput): Promise<PermissionChangeResult> {
    const principal = actor.principal;
    if (!principal) throw forbidden(Permission.PERMISSIONS_MANAGE, 'no principal');
    const input = PermissionChangeInput.parse(raw);
    const now = new Date();
    for (const op of input.changes) {
      if (op.op === 'GRANT' && op.expiresAt && new Date(op.expiresAt).getTime() <= now.getTime()) {
        throw validation('grant_expiry_past', `The grant of ${op.permission} must expire in the future`);
      }
    }
    const change = toRightsChange({ role: input.preset, ops: input.changes });
    // Decided under the user's row lock: the maker rules, the split, and the reductions applied at once.
    const direct = await this.db.transaction(async (tx) => {
      const before = await loadUserRights(tx, userId, { lock: true });
      const after = applyRightsChange(before, change);
      assertMayChangeRights(principal, {
        targetId: userId,
        before,
        after,
        ops: input.changes.length > 0,
        presetOrTeams: input.preset !== undefined && input.preset !== before.role,
        teamsTouched: [],
      });
      assertGrantsAllowed(after);
      const plan = planRightsChange(before, change, now);
      if (isEmptyRightsChange(plan.direct)) return { plan, sessionsEnded: 0 };
      await this.governance.onDirectRightsChange?.(tx, actor, { userId, kind: 'rights' });
      const applied = await applyPermissionChangeSet(tx, actor, toChangeSet(userId, plan.direct, input.reason), { now, maker: principal });
      if (applied.classification.direction === 'INCREASE') throw conflict('changed_concurrently', 'The user changed while you were editing: review and try again');
      return { plan, sessionsEnded: applied.sessionsEnded };
    });
    const { plan, sessionsEnded } = direct;
    const applied = !isEmptyRightsChange(plan.direct) && plan.directClassification.direction !== 'NONE';
    if (!plan.proposed) {
      return { applied, direction: plan.directClassification.direction, appliedClassification: plan.directClassification, sessionsEnded, proposedClassification: null, proposal: null };
    }
    // The widening part: to a checker, or 409 approval_required (saying what already applied).
    let proposal: IdentityProposalRef;
    try {
      proposal = await proposeIncrease(this.governance, actor, {
        objectKind: 'permission_change',
        objectId: userId,
        action: 'UPDATE',
        payload: toChangeSet(userId, plan.proposed, input.reason, principal.userId),
        approval: input.approval,
        reason: input.reason,
      });
    } catch (err) {
      throw withAppliedPart(err, applied ? plan.directClassification : null);
    }
    return { applied, direction: 'INCREASE', appliedClassification: plan.directClassification, sessionsEnded, proposedClassification: plan.proposedClassification, proposal };
  }
}
