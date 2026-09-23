import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  Permission as P,
  ROLE_PERMISSIONS,
  Role,
  assertCan,
  can,
  viaInternalAgent,
  type Principal,
} from '../src/index.js';

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
