import { describe, expect, it } from 'vitest';
import { APPROVAL_CHECK_PERMISSIONS, APPROVAL_MAKE_PERMISSIONS, Permission } from '@ocso/auth';
import { APPROVAL_ACTIONS } from '@ocso/domain';
import { ApprovalRegistry, RUNTIME_KINDS, agentApproval, createApprovalRegistry } from '../../src/approvals/index.js';

/**
 * Coverage is the whole risk of maker–checker (PM/research/11b "risks"): the
 * registered kinds must equal this reviewed list. Adding an approvable
 * configuration object fails here until its descriptor is registered in
 * approvals/composition.ts — wave 2 extends the list.
 */
const APPROVABLE_KINDS = ['agent', 'prompt_version'];

describe('approval coverage', () => {
  const registry = createApprovalRegistry();

  it('registers exactly the reviewed kinds', () => {
    expect([...registry.kinds()].sort()).toEqual([...APPROVABLE_KINDS].sort());
  });

  it('never registers runtime work (claiming, replying, resolving are never approved)', () => {
    for (const kind of RUNTIME_KINDS) expect(registry.has(kind)).toBe(false);
    expect(() => new ApprovalRegistry().register({ ...agentApproval, kind: 'conversation' })).toThrow(/runtime/);
  });

  it('uses only catalogued make and check permissions', () => {
    for (const d of registry.all()) {
      expect(APPROVAL_CHECK_PERMISSIONS as readonly string[]).toContain(d.checkPermission);
      for (const action of d.actions) expect(APPROVAL_MAKE_PERMISSIONS as readonly string[]).toContain(d.makePermission(action));
    }
    expect(() => new ApprovalRegistry().register({ ...agentApproval, kind: 'x', checkPermission: Permission.AGENTS_MANAGE })).toThrow(/approvals\.check/);
    expect(() => createApprovalRegistry().register(agentApproval)).toThrow(/already registered/);
  });

  it('registers no stop action: pause, disable and revoke are never proposals', () => {
    for (const d of registry.all()) for (const action of d.actions) expect(APPROVAL_ACTIONS).toContain(action);
    expect(registry.get('agent').actions).not.toContain('PAUSE' as never);
  });

  it('agents: go live / resume, change and delete; delete needs agents.delete', () => {
    const agent = registry.get('agent');
    expect(agent.actions).toEqual(['ACTIVATE', 'UPDATE', 'DELETE']);
    expect(agent.checkPermission).toBe(Permission.APPROVALS_CHECK_AGENTS);
    expect(agent.makePermission('DELETE')).toBe(Permission.AGENTS_DELETE);
    expect(agent.makePermission('UPDATE')).toBe(Permission.AGENTS_MANAGE);
    expect(registry.get('prompt_version').makePermission('ACTIVATE')).toBe(Permission.PROMPTS_ACTIVATE);
    expect(registry.makePermissions()).toEqual(expect.arrayContaining([Permission.AGENTS_MANAGE, Permission.AGENTS_DELETE, Permission.PROMPTS_ACTIVATE]));
  });
});
