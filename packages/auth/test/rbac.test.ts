import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  APPROVAL_CHECK_PERMISSIONS,
  APPROVAL_MAKE_PERMISSIONS,
  PERMISSION_GROUPS,
  PERMISSION_INFO,
  Permission as P,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  Role,
  assertCan,
  can,
  viaInternalAgent,
  type Principal,
} from '../src/index.js';

const ROLES_WITH = (permission: P) => new Set(Object.values(Role).filter((r) => ROLE_PERMISSIONS[r].has(permission)));

const principal = (role: Role): Principal => ({
  userId: `u-${role}`,
  role,
  displayName: role,
  teamIds: [],
  via: 'UI',
});

describe('role permission matrix', () => {
  it('grants only catalogued permissions', () => {
    for (const perms of Object.values(ROLE_PERMISSIONS)) {
      for (const perm of perms) expect(ALL_PERMISSIONS).toContain(perm);
    }
  });

  it('every permission is granted to at least one role', () => {
    const granted = new Set(Object.values(ROLE_PERMISSIONS).flatMap((s) => [...s]));
    expect(ALL_PERMISSIONS.filter((p) => !granted.has(p))).toEqual([]);
  });

  it.each([
    [Role.SERVICE, P.CONVERSATIONS_REPLY, true],
    [Role.SERVICE, P.CONVERSATIONS_CLAIM, true],
    [Role.SERVICE, P.TOOLS_CONFIRM_SENSITIVE, true],
    [Role.SERVICE, P.PROMPTS_EDIT, false],
    [Role.SERVICE, P.PROVIDERS_MANAGE, false],
    [Role.SERVICE, P.SECRETS_MANAGE, false],
    [Role.SERVICE, P.TELEMETRY_TECHNICAL_READ, false],
    [Role.SERVICE, P.CONVERSATIONS_READ_TEAM, false],
    [Role.SERVICE, P.AGENTS_MANAGE, false],
    [Role.SERVICE, P.AGENTS_READ_ALL, false],
    [Role.HEAD, P.CONVERSATIONS_READ_TEAM, true],
    [Role.HEAD, P.AGENTS_MANAGE, true],
    [Role.HEAD, P.AGENTS_READ_ALL, false],
    [Role.HEAD, P.AGENTS_ASSIGN_OWNER, false],
    [Role.TECH, P.AGENTS_READ_ALL, true],
    [Role.TECH, P.AGENTS_ASSIGN_OWNER, true],
    [Role.TECH, P.AGENTS_MANAGE, false],
    [Role.HEAD, P.PROMPTS_ACTIVATE, true],
    [Role.HEAD, P.QUEUES_MANAGE, true],
    [Role.HEAD, P.ANALYTICS_BUSINESS_READ, true],
    [Role.HEAD, P.SYSTEM_CONFIGURE, false],
    [Role.HEAD, P.TELEMETRY_TECHNICAL_READ, false],
    [Role.HEAD, P.PROVIDERS_MANAGE, false],
    [Role.HEAD, P.USERS_MANAGE, false],
    [Role.TECH, P.SYSTEM_CONFIGURE, true],
    [Role.TECH, P.MCP_MANAGE, true],
    [Role.TECH, P.SECRETS_MANAGE, true],
    [Role.TECH, P.CONVERSATIONS_READ, false],
    [Role.TECH, P.PROMPTS_EDIT, false],
    [Role.TECH, P.ANALYTICS_BUSINESS_READ, false],
    [Role.HEAD, P.MESSAGE_TEMPLATES_MANAGE, true],
    [Role.TECH, P.MESSAGE_TEMPLATES_MANAGE, true],
    [Role.SERVICE, P.MESSAGE_TEMPLATES_MANAGE, false],
  ] as const)('%s → %s = %s', (role, permission, expected) => {
    expect(can(principal(role), permission)).toBe(expected);
  });

  it('presets nest: Service ⊂ Lead ⊂ Head', () => {
    const within = (a: Role, b: Role) => [...ROLE_PERMISSIONS[a]].every((p) => ROLE_PERMISSIONS[b].has(p));
    expect(within(Role.SERVICE, Role.LEAD)).toBe(true);
    expect(within(Role.LEAD, Role.HEAD)).toBe(true);
    expect(ROLE_PERMISSIONS[Role.LEAD].size).toBeGreaterThan(ROLE_PERMISSIONS[Role.SERVICE].size);
    expect(ROLE_PERMISSIONS[Role.HEAD].size).toBeGreaterThan(ROLE_PERMISSIONS[Role.LEAD].size);
  });

  it('Tech holds no conversation content, prompt editing, business analytics or business check permission', () => {
    const tech = ROLE_PERMISSIONS[Role.TECH];
    for (const p of [P.CONVERSATIONS_READ, P.CONVERSATIONS_READ_TEAM, P.CONVERSATIONS_REPLY, P.PROMPTS_EDIT, P.ANALYTICS_BUSINESS_READ]) expect(tech.has(p), p).toBe(false);
    for (const p of [P.APPROVALS_CHECK_AGENTS, P.APPROVALS_CHECK_ROUTING, P.APPROVALS_CHECK_CHANNELS]) expect(tech.has(p), p).toBe(false);
    for (const p of [P.APPROVALS_CHECK_PLATFORM, P.APPROVALS_CHECK_PERMISSIONS, P.APPROVALS_REASSIGN_ANY, P.PERMISSIONS_MANAGE, P.AUDIT_VERIFY]) expect(tech.has(p), p).toBe(true);
  });

  it('Service and Lead check nothing; Head holds all five check permissions', () => {
    for (const role of [Role.SERVICE, Role.LEAD]) {
      for (const p of APPROVAL_CHECK_PERMISSIONS) expect(ROLE_PERMISSIONS[role].has(p), `${role} ${p}`).toBe(false);
    }
    for (const p of APPROVAL_CHECK_PERMISSIONS) expect(ROLE_PERMISSIONS[Role.HEAD].has(p), p).toBe(true);
    expect(APPROVAL_CHECK_PERMISSIONS).toHaveLength(5);
  });

  it('Head and Lead pause; Service does not; deleting is Head only', () => {
    expect(can(principal(Role.LEAD), P.AGENTS_PAUSE)).toBe(true);
    expect(can(principal(Role.HEAD), P.AGENTS_PAUSE)).toBe(true);
    expect(can(principal(Role.SERVICE), P.AGENTS_PAUSE)).toBe(false);
    for (const p of [P.AGENTS_DELETE, P.MESSAGE_TEMPLATES_DELETE]) {
      expect(can(principal(Role.HEAD), p)).toBe(true);
      expect(can(principal(Role.LEAD), p)).toBe(false);
      expect(can(principal(Role.TECH), p)).toBe(false);
    }
  });

  it('who shapes people: users.manage for Tech, users.manage_team for Lead and Head, permissions.manage for Head and Tech', () => {
    expect([...ROLES_WITH(P.USERS_MANAGE)]).toEqual([Role.TECH]);
    expect([...ROLES_WITH(P.USERS_MANAGE_TEAM)].sort()).toEqual([Role.HEAD, Role.LEAD]);
    expect([...ROLES_WITH(P.PERMISSIONS_MANAGE)].sort()).toEqual([Role.HEAD, Role.TECH]);
    expect([...ROLES_WITH(P.PERMISSIONS_READ)].sort()).toEqual([Role.HEAD, Role.LEAD, Role.TECH]);
    expect([...ROLES_WITH(P.APPROVALS_READ)].sort()).toEqual([Role.HEAD, Role.LEAD, Role.SERVICE, Role.TECH]);
  });

  it('the make and check lists hold only catalogued permissions', () => {
    for (const p of [...APPROVAL_CHECK_PERMISSIONS, ...APPROVAL_MAKE_PERMISSIONS]) expect(ALL_PERMISSIONS).toContain(p);
  });

  it('every preset has a label', () => {
    expect(Object.keys(ROLE_LABELS).sort()).toEqual(Object.values(Role).sort());
  });

  it('every role can use the internal agent', () => {
    for (const role of Object.values(Role)) expect(can(principal(role), P.INTERNAL_AGENT_USE)).toBe(true);
  });

  it('assertCan throws a typed authorization error', () => {
    expect(() => assertCan(principal(Role.SERVICE), P.SYSTEM_CONFIGURE)).toThrowError(/system.configure/);
    try {
      assertCan(principal(Role.SERVICE), P.SYSTEM_CONFIGURE);
    } catch (e) {
      expect((e as { category: string }).category).toBe('authorization');
    }
  });

  it('internal agent actions keep the same user and RBAC', () => {
    const exec = viaInternalAgent(principal(Role.SERVICE));
    expect(exec.via).toBe('INTERNAL_AGENT');
    expect(can(exec, P.PROVIDERS_MANAGE)).toBe(false);
    expect(can(exec, P.CONVERSATIONS_REPLY)).toBe(true);
  });
});

describe('permission catalogue labels', () => {
  it('every permission has a label, a known group and a description', () => {
    expect(Object.keys(PERMISSION_INFO).sort()).toEqual([...ALL_PERMISSIONS].sort());
    for (const permission of ALL_PERMISSIONS) {
      const info = PERMISSION_INFO[permission];
      expect(info.label.trim().length, permission).toBeGreaterThan(2);
      expect(info.description.trim().length, permission).toBeGreaterThan(10);
      expect(PERMISSION_GROUPS, permission).toContain(info.group);
    }
  });

  it('labels are unique so a list never shows two identical rows', () => {
    const labels = ALL_PERMISSIONS.map((p) => PERMISSION_INFO[p].label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('every group is used', () => {
    const used = new Set(ALL_PERMISSIONS.map((p) => PERMISSION_INFO[p].group));
    expect([...PERMISSION_GROUPS].filter((g) => !used.has(g))).toEqual([]);
  });
});
