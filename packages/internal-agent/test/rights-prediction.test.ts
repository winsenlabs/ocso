import { describe, expect, it } from 'vitest';
import { capabilityByName, type Capability } from '../src/index.js';
import { widensRights } from '../src/runtime/rights.js';

/**
 * A people change that widens rights waits for a checker (PM/research/11 §3.4), so its card asks for one up
 * front (found by the Ask OCSO evaluation head.governed-promote: the card said "Applies now" for a promotion).
 */
const cap = (name: string) => capabilityByName(name) as Capability;
const sam = { id: 'u', role: 'SERVICE', status: 'ACTIVE', teamIds: ['cards'] };

describe('widensRights', () => {
  it('a preset with more rights, a new team, a grant, a re-enable: widening', () => {
    expect(widensRights(cap('users.change_user_permissions'), { preset: 'LEAD', reason: 'x' }, sam)).toBe(true);
    expect(widensRights(cap('users.update_user'), { role: 'HEAD' }, sam)).toBe(true);
    expect(widensRights(cap('users.update_user'), { teamIds: ['cards', 'loans'] }, sam)).toBe(true);
    expect(widensRights(cap('users.change_user_permissions'), { changes: [{ op: 'GRANT', permission: 'agents.pause' }], reason: 'x' }, sam)).toBe(true);
    expect(widensRights(cap('users.update_user'), { status: 'ACTIVE' }, { ...sam, status: 'DISABLED' })).toBe(true);
    expect(widensRights(cap('users.add_team_member'), { userId: 'u' }, { id: 'loans', name: 'Loans' })).toBe(true);
  });

  it('reductions, unchanged values and other tools: not widening (the route still decides)', () => {
    const head = { ...sam, role: 'HEAD' };
    expect(widensRights(cap('users.change_user_permissions'), { preset: 'LEAD', reason: 'x' }, head)).toBe(false);
    expect(widensRights(cap('users.update_user'), { teamIds: ['cards'] }, sam)).toBe(false);
    expect(widensRights(cap('users.update_user'), { status: 'DISABLED' }, sam)).toBe(false);
    expect(widensRights(cap('users.change_user_permissions'), { changes: [{ op: 'REVOKE', permission: 'copilot.use' }], reason: 'x' }, sam)).toBe(false);
    expect(widensRights(cap('users.update_user'), { role: 'LEAD' }, null)).toBe(false);
    expect(widensRights(cap('users.update_team'), { name: 'x' }, sam)).toBe(false);
  });
});
