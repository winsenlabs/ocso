import { describe, expect, it } from 'vitest';
import {
  NON_GRANTABLE_BY_PRESET,
  Permission as P,
  ROLE_PERMISSIONS,
  ROLES,
  Role,
  forbiddenGrants,
  mfaRequiredFor,
  planRightsChange,
  splitRightsChange,
  computeEffectivePermissions,
  type PermissionOverride,
  type RightsState,
} from '../src/index.js';

const NOW = new Date('2026-09-23T10:00:00Z');
const later = (days: number) => new Date(NOW.getTime() + days * 86_400_000);
const T1 = '00000000-0000-4000-8000-000000000001';
const T2 = '00000000-0000-4000-8000-000000000002';
const state = (over: Partial<RightsState> = {}): RightsState => ({ role: Role.LEAD, status: 'ACTIVE', teamIds: [T1], overrides: [], ...over });
const grant = (permission: P, expiresAt: Date | null = null): PermissionOverride => ({ permission, effect: 'GRANT', expiresAt });
const revoke = (permission: P): PermissionOverride => ({ permission, effect: 'REVOKE', expiresAt: null });

describe('planning a change: reductions apply at once even beside an increase (§3.4)', () => {
  it('REVOKE + GRANT: the revoke applies now, the grant waits', () => {
    const plan = planRightsChange(state(), { ops: [{ op: 'REVOKE', permission: P.APPROVALS_READ }, { op: 'GRANT', permission: P.TEAMS_MANAGE, expiresAt: null }] }, NOW);
    expect(plan.direct.ops).toEqual([{ op: 'REVOKE', permission: P.APPROVALS_READ }]);
    expect(plan.directClassification).toMatchObject({ direction: 'DECREASE', lost: [P.APPROVALS_READ] });
    expect(plan.proposed?.ops).toEqual([{ op: 'GRANT', permission: P.TEAMS_MANAGE, expiresAt: null }]);
    expect(plan.proposedClassification).toMatchObject({ direction: 'INCREASE', gained: [P.TEAMS_MANAGE] });
  });

  it('a team move: leaving T1 applies now, joining T2 waits', () => {
    const plan = planRightsChange(state(), { teams: { add: [T2], remove: [T1] } }, NOW);
    expect(plan.direct.teams).toEqual({ add: [], remove: [T1] });
    expect(plan.proposed?.teams).toEqual({ add: [T2], remove: [] });
    expect(plan.proposedClassification?.teamsAdded).toEqual([T2]);
  });

  it('Head → Lead plus a team: the downgrade applies now, the team waits', () => {
    const plan = planRightsChange(state({ role: Role.HEAD }), { role: Role.LEAD, teams: { add: [T2] } }, NOW);
    expect(plan.direct.role).toBe(Role.LEAD);
    expect(plan.directClassification.lost).toContain(P.TEAMS_MANAGE);
    expect(plan.proposed).toEqual({ teams: { add: [T2], remove: [] } });
  });

  it('disable plus upgrade: the disable applies now, the upgrade waits', () => {
    const plan = planRightsChange(state(), { status: 'DISABLED', role: Role.HEAD }, NOW);
    expect(plan.direct).toEqual({ status: 'DISABLED' });
    expect(plan.proposed).toEqual({ role: Role.HEAD });
  });

  it('a sideways preset change (Head → Tech) is an increase, not a downgrade', () => {
    expect(splitRightsChange(state({ role: Role.HEAD }), { role: Role.TECH }, NOW).increase).toEqual({ role: Role.TECH });
  });

  it('a pure decrease or a pure increase is not split', () => {
    expect(planRightsChange(state(), { role: Role.SERVICE, teams: { remove: [T1] } }, NOW)).toMatchObject({ proposed: null, directClassification: { direction: 'DECREASE' } });
    const up = planRightsChange(state(), { role: Role.HEAD }, NOW);
    expect(up.direct).toEqual({});
    expect(up.directClassification.direction).toBe('NONE');
    expect(up.proposed).toEqual({ role: Role.HEAD });
  });

  it('shortening a live grant applies now; lengthening or renewing waits', () => {
    const shortened = planRightsChange(state({ overrides: [grant(P.TEAMS_MANAGE, later(9))] }), { ops: [{ op: 'GRANT', permission: P.TEAMS_MANAGE, expiresAt: later(2) }] }, NOW);
    expect(shortened.proposed).toBeNull();
    const lengthened = planRightsChange(state({ overrides: [grant(P.TEAMS_MANAGE, later(2))] }), { ops: [{ op: 'GRANT', permission: P.TEAMS_MANAGE, expiresAt: later(9) }] }, NOW);
    expect(lengthened.proposed?.ops).toHaveLength(1);
    const renewed = planRightsChange(state({ overrides: [grant(P.TEAMS_MANAGE, later(-1))] }), { ops: [{ op: 'GRANT', permission: P.TEAMS_MANAGE, expiresAt: later(2) }] }, NOW);
    expect(renewed.proposed?.ops).toHaveLength(1);
  });

  it('CLEAR of a revoke hands a preset permission back (waits); of a grant takes it away (now)', () => {
    const plan = planRightsChange(state({ overrides: [revoke(P.QUEUES_MANAGE), grant(P.TEAMS_MANAGE)] }), { ops: [{ op: 'CLEAR', permission: P.QUEUES_MANAGE }, { op: 'CLEAR', permission: P.TEAMS_MANAGE }] }, NOW);
    expect(plan.direct.ops).toEqual([{ op: 'CLEAR', permission: P.TEAMS_MANAGE }]);
    expect(plan.proposed?.ops).toEqual([{ op: 'CLEAR', permission: P.QUEUES_MANAGE }]);
  });

  it('a pending user is a draft: preset and teams apply, grants still wait', () => {
    const pending = state({ status: 'PENDING_APPROVAL' });
    expect(planRightsChange(pending, { role: Role.HEAD, teams: { add: [T2] } }, NOW).proposed).toBeNull();
    expect(planRightsChange(pending, { ops: [{ op: 'GRANT', permission: P.TEAMS_MANAGE, expiresAt: null }] }, NOW).proposed?.ops).toHaveLength(1);
  });

  it('a disabled user stays governed: an upgrade while disabled waits for approval', () => {
    expect(planRightsChange(state({ status: 'DISABLED' }), { role: Role.HEAD }, NOW).proposed).toEqual({ role: Role.HEAD });
  });
});

describe('grants a preset can never hold', () => {
  it('Tech can never be granted conversation content, prompts.edit or business analytics', () => {
    for (const p of [P.CONVERSATIONS_READ, P.CONVERSATIONS_READ_TEAM, P.CONVERSATIONS_REPLY, P.CUSTOMERS_READ, P.PROMPTS_EDIT, P.ANALYTICS_BUSINESS_READ]) {
      expect(NON_GRANTABLE_BY_PRESET.TECH.has(p), p).toBe(true);
    }
    expect(forbiddenGrants({ role: Role.TECH, overrides: [grant(P.CONVERSATIONS_READ_TEAM), grant(P.QUEUES_MANAGE), revoke(P.CONVERSATIONS_READ)] })).toEqual([P.CONVERSATIONS_READ_TEAM]);
    expect(forbiddenGrants({ role: Role.HEAD, overrides: [grant(P.CONVERSATIONS_READ_TEAM)] })).toEqual([]);
  });

  it('never contradicts a preset: no preset holds what it can never be granted', () => {
    for (const role of ROLES) for (const p of NON_GRANTABLE_BY_PRESET[role]) expect(ROLE_PERMISSIONS[role].has(p), `${role} ${p}`).toBe(false);
  });
});

describe('MFA follows rights, not only presets', () => {
  it('a listed preset requires MFA; others only when a grant gives them a permission a listed preset holds', () => {
    expect(mfaRequiredFor(Role.TECH, undefined, [Role.TECH])).toBe(true);
    expect(mfaRequiredFor(Role.SERVICE, ROLE_PERMISSIONS.SERVICE, [Role.TECH])).toBe(false);
    const granted = computeEffectivePermissions(Role.SERVICE, [grant(P.USERS_MANAGE)], NOW);
    expect(mfaRequiredFor(Role.SERVICE, granted, [Role.TECH])).toBe(true);
    // A grant of something no listed preset holds changes nothing; and a Lead is not swept in by Head's list.
    expect(mfaRequiredFor(Role.SERVICE, computeEffectivePermissions(Role.SERVICE, [grant(P.PROMPTS_EDIT)], NOW), [Role.TECH])).toBe(false);
    expect(mfaRequiredFor(Role.LEAD, ROLE_PERMISSIONS.LEAD, [Role.HEAD])).toBe(false);
    expect(mfaRequiredFor(Role.LEAD, computeEffectivePermissions(Role.LEAD, [grant(P.PERMISSIONS_MANAGE)], NOW), [Role.HEAD])).toBe(true);
  });
});
