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
    [Role.CS_EXEC, P.CONVERSATIONS_REPLY, true],
    [Role.CS_EXEC, P.CONVERSATIONS_CLAIM, true],
    [Role.CS_EXEC, P.TOOLS_CONFIRM_SENSITIVE, true],
    [Role.CS_EXEC, P.PROMPTS_EDIT, false],
    [Role.CS_EXEC, P.PROVIDERS_MANAGE, false],
    [Role.CS_EXEC, P.SECRETS_MANAGE, false],
    [Role.CS_EXEC, P.TELEMETRY_TECHNICAL_READ, false],
    [Role.CS_EXEC, P.CONVERSATIONS_READ_TEAM, false],
    [Role.CS_EXEC, P.AGENTS_MANAGE, false],
    [Role.CS_EXEC, P.AGENTS_READ_ALL, false],
    [Role.CS_LEAD, P.CONVERSATIONS_READ_TEAM, true],
    [Role.CS_LEAD, P.AGENTS_MANAGE, true],
    [Role.CS_LEAD, P.AGENTS_READ_ALL, false],
    [Role.CS_LEAD, P.AGENTS_ASSIGN_OWNER, false],
    [Role.PLATFORM_TECH_ADMIN, P.AGENTS_READ_ALL, true],
    [Role.PLATFORM_TECH_ADMIN, P.AGENTS_ASSIGN_OWNER, true],
    [Role.PLATFORM_TECH_ADMIN, P.AGENTS_MANAGE, false],
    [Role.CS_LEAD, P.PROMPTS_ACTIVATE, true],
    [Role.CS_LEAD, P.QUEUES_MANAGE, true],
    [Role.CS_LEAD, P.ANALYTICS_BUSINESS_READ, true],
    [Role.CS_LEAD, P.SYSTEM_CONFIGURE, false],
    [Role.CS_LEAD, P.TELEMETRY_TECHNICAL_READ, false],
    [Role.CS_LEAD, P.PROVIDERS_MANAGE, false],
    [Role.CS_LEAD, P.USERS_MANAGE, false],
    [Role.PLATFORM_TECH_ADMIN, P.SYSTEM_CONFIGURE, true],
    [Role.PLATFORM_TECH_ADMIN, P.MCP_MANAGE, true],
    [Role.PLATFORM_TECH_ADMIN, P.SECRETS_MANAGE, true],
    [Role.PLATFORM_TECH_ADMIN, P.CONVERSATIONS_READ, false],
    [Role.PLATFORM_TECH_ADMIN, P.PROMPTS_EDIT, false],
    [Role.PLATFORM_TECH_ADMIN, P.ANALYTICS_BUSINESS_READ, false],
    [Role.CS_LEAD, P.WHATSAPP_TEMPLATES_MANAGE, true],
    [Role.PLATFORM_TECH_ADMIN, P.WHATSAPP_TEMPLATES_MANAGE, true],
    [Role.CS_EXEC, P.WHATSAPP_TEMPLATES_MANAGE, false],
  ] as const)('%s → %s = %s', (role, permission, expected) => {
    expect(can(principal(role), permission)).toBe(expected);
  });

  it('every role can use the internal agent', () => {
    for (const role of Object.values(Role)) expect(can(principal(role), P.INTERNAL_AGENT_USE)).toBe(true);
  });

  it('assertCan throws a typed authorization error', () => {
    expect(() => assertCan(principal(Role.CS_EXEC), P.SYSTEM_CONFIGURE)).toThrowError(/system.configure/);
    try {
      assertCan(principal(Role.CS_EXEC), P.SYSTEM_CONFIGURE);
    } catch (e) {
      expect((e as { category: string }).category).toBe('authorization');
    }
  });

  it('internal agent actions keep the same user and RBAC', () => {
    const exec = viaInternalAgent(principal(Role.CS_EXEC));
    expect(exec.via).toBe('INTERNAL_AGENT');
    expect(can(exec, P.PROVIDERS_MANAGE)).toBe(false);
    expect(can(exec, P.CONVERSATIONS_REPLY)).toBe(true);
  });
});
