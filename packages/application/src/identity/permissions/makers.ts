import { Permission, assertCan, can, computeEffectivePermissions, rightsWithin, type Principal, type RightsState } from '@ocso/auth';
import { forbidden } from '@ocso/domain';

export interface RightsChangeScope {
  /** The user being shaped; null while creating one. */
  targetId: string | null;
  before: RightsState | null;
  after: RightsState;
  /** The change carries per-user grants/revokes/clears (permissions.manage). */
  ops: boolean;
  /** The change sets the preset or memberships, or creates the user (users.manage / users.manage_team). */
  presetOrTeams: boolean;
  /** Teams joined or left. */
  teamsTouched: readonly string[];
}

/**
 * Maker rules for shaping someone's rights (PM/research/11 §3.4). Never self.
 * `users.manage` shapes anyone. Everyone else acts inside their teams: the target
 * shares a team with them, memberships change only on their own teams, and the
 * target's rights — before and after — fit inside their own (containment).
 */
export function assertMayChangeRights(principal: Principal, scope: RightsChangeScope): void {
  if (scope.targetId === principal.userId) throw forbidden(Permission.PERMISSIONS_MANAGE, 'you cannot change your own access; ask a colleague');
  if (scope.ops) assertCan(principal, Permission.PERMISSIONS_MANAGE);
  if (scope.presetOrTeams && !can(principal, Permission.USERS_MANAGE) && !can(principal, Permission.USERS_MANAGE_TEAM)) {
    throw forbidden(Permission.USERS_MANAGE_TEAM, 'you cannot change presets or memberships');
  }
  if (can(principal, Permission.USERS_MANAGE)) return;

  const own = new Set(principal.teamIds);
  // A new user must land in one of your teams, or you could never reach (approve, fix or discard) them again.
  if (!scope.before && !scope.after.teamIds.some((t) => own.has(t))) {
    throw forbidden(Permission.USERS_MANAGE_TEAM, 'place the new user in at least one of your teams');
  }
  // Sharing a team before or after: placing someone in your own team is how a team manager reaches them.
  if (scope.before && ![...scope.before.teamIds, ...scope.after.teamIds].some((t) => own.has(t))) {
    throw forbidden(Permission.USERS_MANAGE_TEAM, 'you shape only colleagues who share a team with you');
  }
  if (scope.teamsTouched.some((t) => !own.has(t))) throw forbidden(Permission.USERS_MANAGE_TEAM, 'you change memberships of your own teams only');
  const fits = (state: RightsState) => rightsWithin(computeEffectivePermissions(state.role, state.overrides), principal);
  if ((scope.before && !fits(scope.before)) || !fits(scope.after)) {
    throw forbidden(Permission.USERS_MANAGE_TEAM, 'you shape only colleagues whose rights do not exceed yours');
  }
}
