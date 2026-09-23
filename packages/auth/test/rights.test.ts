import { describe, expect, it } from 'vitest';
import {
  Permission as P,
  ROLE_PERMISSIONS,
  Role,
  applyRightsChange,
  classifyRightsChange,
  computeEffectivePermissions,
  effectiveOf,
  isOverrideActive,
  rightsWithin,
  type PermissionOverride,
  type RightsChange,
  type RightsState,
} from '../src/index.js';

const NOW = new Date('2026-09-23T10:00:00Z');
const later = (days: number) => new Date(NOW.getTime() + days * 86_400_000);
const T1 = '00000000-0000-4000-8000-000000000001';
const T2 = '00000000-0000-4000-8000-000000000002';

const state = (over: Partial<RightsState> = {}): RightsState => ({ role: Role.LEAD, status: 'ACTIVE', teamIds: [T1], overrides: [], ...over });
const classify = (before: RightsState, change: RightsChange) => classifyRightsChange(before, applyRightsChange(before, change), NOW);
const grant = (permission: P, expiresAt: Date | null = null): PermissionOverride => ({ permission, effect: 'GRANT', expiresAt });
const revoke = (permission: P): PermissionOverride => ({ permission, effect: 'REVOKE', expiresAt: null });

describe('effective permissions', () => {
  it('is the preset plus active grants minus active revokes', () => {
    const set = computeEffectivePermissions(Role.SERVICE, [grant(P.QUEUES_MANAGE), revoke(P.COPILOT_USE)], NOW);
    expect(set.has(P.QUEUES_MANAGE)).toBe(true);
    expect(set.has(P.COPILOT_USE)).toBe(false);
    expect(set.has(P.CONVERSATIONS_REPLY)).toBe(true);
    expect(set.size).toBe(ROLE_PERMISSIONS.SERVICE.size);
  });

  it('honours expiry: an expired grant counts as absent, computed and never swept', () => {
    expect(isOverrideActive({ expiresAt: later(-1) }, NOW)).toBe(false);
    expect(isOverrideActive({ expiresAt: NOW }, NOW)).toBe(false);
    expect(isOverrideActive({ expiresAt: later(1) }, NOW)).toBe(true);
    expect(isOverrideActive({ expiresAt: null }, NOW)).toBe(true);
    expect(computeEffectivePermissions(Role.SERVICE, [grant(P.QUEUES_MANAGE, later(-1))], NOW).has(P.QUEUES_MANAGE)).toBe(false);
    expect(computeEffectivePermissions(Role.SERVICE, [grant(P.QUEUES_MANAGE, later(2))], NOW).has(P.QUEUES_MANAGE)).toBe(true);
  });

  it('gives an inert user nothing', () => {
    expect(effectiveOf(state({ status: 'PENDING_APPROVAL' }), NOW).size).toBe(0);
    expect(effectiveOf(state({ status: 'DISABLED' }), NOW).size).toBe(0);
    expect(effectiveOf(state(), NOW).size).toBe(ROLE_PERMISSIONS.LEAD.size);
  });
});

describe('applying a change set', () => {
  it('replaces the override of a permission, clears it, and edits memberships', () => {
    const before = state({ overrides: [grant(P.TEAMS_MANAGE)] });
    const after = applyRightsChange(before, {
      ops: [{ op: 'REVOKE', permission: P.TEAMS_MANAGE }, { op: 'GRANT', permission: P.SLA_MANAGE, expiresAt: later(3) }, { op: 'CLEAR', permission: P.SLA_MANAGE }],
      teams: { add: [T2, T2], remove: [T1] },
      role: Role.HEAD,
    });
    expect(after.overrides).toEqual([revoke(P.TEAMS_MANAGE)]);
    expect(after.teamIds).toEqual([T2]);
    expect(after.role).toBe(Role.HEAD);
    expect(after.status).toBe('ACTIVE');
  });
});

describe('classifying a change (increase needs approval, decrease applies at once)', () => {
  it.each<[string, RightsState, RightsChange, 'INCREASE' | 'DECREASE' | 'NONE']>([
    ['GRANT of a new permission', state(), { ops: [{ op: 'GRANT', permission: P.TEAMS_MANAGE, expiresAt: null }] }, 'INCREASE'],
    ['GRANT of a permission the preset already has (lasts beyond a later downgrade)', state(), { ops: [{ op: 'GRANT', permission: P.QUEUES_MANAGE, expiresAt: null }] }, 'INCREASE'],
    ['GRANT lengthening an expiring grant', state({ overrides: [grant(P.TEAMS_MANAGE, later(2))] }), { ops: [{ op: 'GRANT', permission: P.TEAMS_MANAGE, expiresAt: later(9) }] }, 'INCREASE'],
    ['GRANT making an expiring grant permanent', state({ overrides: [grant(P.TEAMS_MANAGE, later(2))] }), { ops: [{ op: 'GRANT', permission: P.TEAMS_MANAGE, expiresAt: null }] }, 'INCREASE'],
    ['GRANT renewing an expired grant', state({ overrides: [grant(P.TEAMS_MANAGE, later(-2))] }), { ops: [{ op: 'GRANT', permission: P.TEAMS_MANAGE, expiresAt: later(2) }] }, 'INCREASE'],
    ['GRANT shortening a grant', state({ overrides: [grant(P.TEAMS_MANAGE, null)] }), { ops: [{ op: 'GRANT', permission: P.TEAMS_MANAGE, expiresAt: later(2) }] }, 'DECREASE'],
    ['CLEAR of a REVOKE', state({ overrides: [revoke(P.QUEUES_MANAGE)] }), { ops: [{ op: 'CLEAR', permission: P.QUEUES_MANAGE }] }, 'INCREASE'],
    ['REVOKE of a preset permission', state(), { ops: [{ op: 'REVOKE', permission: P.QUEUES_MANAGE }] }, 'DECREASE'],
    ['REVOKE of a permission never held (pre-emptive)', state(), { ops: [{ op: 'REVOKE', permission: P.SECRETS_MANAGE }] }, 'DECREASE'],
    ['CLEAR of a GRANT', state({ overrides: [grant(P.TEAMS_MANAGE)] }), { ops: [{ op: 'CLEAR', permission: P.TEAMS_MANAGE }] }, 'DECREASE'],
    ['CLEAR of nothing', state(), { ops: [{ op: 'CLEAR', permission: P.TEAMS_MANAGE }] }, 'NONE'],
    ['preset upgrade Lead → Head', state(), { role: Role.HEAD }, 'INCREASE'],
    ['preset downgrade Lead → Service', state(), { role: Role.SERVICE }, 'DECREASE'],
    ['preset sideways Head → Tech gains platform rights', state({ role: Role.HEAD }), { role: Role.TECH }, 'INCREASE'],
    ['the same preset again', state(), { role: Role.LEAD }, 'NONE'],
    ['team added', state(), { teams: { add: [T2] } }, 'INCREASE'],
    ['team removed', state(), { teams: { remove: [T1] } }, 'DECREASE'],
    ['disable', state(), { status: 'DISABLED' }, 'DECREASE'],
    ['re-enable a disabled user', state({ status: 'DISABLED' }), { status: 'ACTIVE' }, 'INCREASE'],
    ['preset upgrade while disabled (an approved user stays governed while disabled)', state({ status: 'DISABLED' }), { role: Role.HEAD }, 'INCREASE'],
    ['team added while disabled', state({ status: 'DISABLED' }), { teams: { add: [T2] } }, 'INCREASE'],
    ['preset upgrade while pending approval (a draft: its creation approval binds the rights)', state({ status: 'PENDING_APPROVAL' }), { role: Role.HEAD }, 'DECREASE'],
    ['team added while pending approval (a draft)', state({ status: 'PENDING_APPROVAL' }), { teams: { add: [T2] } }, 'DECREASE'],
    ['GRANT while pending approval is still an increase', state({ status: 'PENDING_APPROVAL' }), { ops: [{ op: 'GRANT', permission: P.TEAMS_MANAGE, expiresAt: null }] }, 'INCREASE'],
    ['mixed: a downgrade with one grant is an increase as a whole', state({ role: Role.HEAD }), { role: Role.SERVICE, ops: [{ op: 'GRANT', permission: P.QUEUES_MANAGE, expiresAt: null }] }, 'INCREASE'],
    ['mixed: a new team with a downgrade is an increase', state(), { role: Role.SERVICE, teams: { add: [T2] } }, 'INCREASE'],
    ['disable plus upgrade is still an increase (planRightsChange applies the disable at once)', state(), { status: 'DISABLED', role: Role.HEAD }, 'INCREASE'],
  ])('%s', (_name, before, change, expected) => {
    expect(classify(before, change).direction).toBe(expected);
  });

  it('reports what was gained and lost', () => {
    const c = classify(state({ role: Role.HEAD }), { role: Role.LEAD, ops: [{ op: 'REVOKE', permission: P.QUEUES_MANAGE }], teams: { add: [T2], remove: [T1] } });
    expect(c.gained).toEqual([]);
    expect(c.lost).toContain(P.TEAMS_MANAGE);
    expect(c.lost).toContain(P.QUEUES_MANAGE);
    expect(c.teamsAdded).toEqual([T2]);
    expect(c.teamsRemoved).toEqual([T1]);
    expect(c.direction).toBe('INCREASE');
  });

  it('flags activation and deactivation', () => {
    expect(classify(state({ status: 'PENDING_APPROVAL' }), { status: 'ACTIVE' })).toMatchObject({ activated: true, direction: 'INCREASE' });
    expect(classify(state(), { status: 'DISABLED' })).toMatchObject({ deactivated: true, direction: 'DECREASE' });
  });
});

describe('containment (users.manage_team)', () => {
  const lead = { userId: 'u', role: Role.LEAD, displayName: 'L', teamIds: [], via: 'UI' as const };
  it('a Lead may shape a Service member, never a Head', () => {
    expect(rightsWithin(ROLE_PERMISSIONS.SERVICE, lead)).toBe(true);
    expect(rightsWithin(ROLE_PERMISSIONS.HEAD, lead)).toBe(false);
  });
  it("uses the maker's effective set, grants included", () => {
    const granted = { ...lead, permissions: computeEffectivePermissions(Role.LEAD, [grant(P.TEAMS_MANAGE)], NOW) };
    expect(rightsWithin([P.TEAMS_MANAGE], granted)).toBe(true);
    expect(rightsWithin([P.TEAMS_MANAGE], lead)).toBe(false);
  });
});
