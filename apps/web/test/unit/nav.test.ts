import { describe, expect, it } from 'vitest';
import { permissionsForRole, type Role } from '@ocso/auth';
import { buildNav, homeVariant } from '../../lib/nav';
import { activeNavKey, areaLabel } from '../../lib/nav-active';

const navFor = (role: Role) => buildNav(new Set(permissionsForRole(role)));
const labels = (role: Role) => navFor(role).flatMap((g) => (g.label ? [g.label] : []));
const items = (role: Role) => navFor(role).flatMap((g) => g.items.map((i) => i.label));

describe('buildNav (design/OCSONav.dc.html, derived from permissions)', () => {
  it('gives CS Exec only "My work"', () => {
    expect(labels('CS_EXEC')).toEqual(['My work']);
    expect(items('CS_EXEC')).toEqual(['Home', 'Search', 'Conversations', 'Pickup queue', 'Customers', 'Alerts', 'My connections', 'Settings']);
  });

  it('gives CS Lead Operations, Quality and Governance', () => {
    expect(labels('CS_LEAD')).toEqual(['Operations', 'Quality', 'Governance']);
    expect(items('CS_LEAD')).toEqual([
      'Home', 'Search',
      'Conversations', 'Virtual agents', 'Queues', 'Customers', 'Message templates',
      'Analytics', 'Reviews', 'Prompt corrections', 'Escalation reasons',
      'Alerts', 'SLA policies', 'Team',
      'My connections', 'Settings',
    ]);
  });

  it('gives Platform Tech Admin Platform, Integrations and Oversight — no conversation content', () => {
    expect(labels('PLATFORM_TECH_ADMIN')).toEqual(['Platform', 'Integrations', 'Oversight']);
    expect(items('PLATFORM_TECH_ADMIN')).not.toContain('Conversations');
    expect(items('PLATFORM_TECH_ADMIN')).toContain('Team & roles');
    expect(items('PLATFORM_TECH_ADMIN')).toContain('Message templates');
    expect(items('CS_EXEC')).not.toContain('Message templates');
  });

  it('drops items whose permission is missing and empty groups', () => {
    const nav = buildNav(new Set(['analytics.business.read'] as const));
    expect(nav.map((g) => g.key)).toEqual(['top', 'quality', 'bottom']);
    expect(nav.find((g) => g.key === 'quality')?.items.map((i) => i.key)).toEqual(['analytics', 'escalation-reasons']);
  });

  it('picks the role home from permissions', () => {
    expect(homeVariant(new Set(permissionsForRole('CS_EXEC')))).toBe('exec');
    expect(homeVariant(new Set(permissionsForRole('CS_LEAD')))).toBe('lead');
    expect(homeVariant(new Set(permissionsForRole('PLATFORM_TECH_ADMIN')))).toBe('admin');
  });
});

describe('activeNavKey', () => {
  const admin = navFor('PLATFORM_TECH_ADMIN');

  it('highlights My connections for the personal tab', () => {
    expect(activeNavKey(navFor('CS_EXEC'), '/connections', 'mine')).toBe('bottom:my-connections');
  });

  it('prefers the longest matching path', () => {
    expect(activeNavKey(admin, '/system', null)).toBe('platform:system');
    expect(activeNavKey(admin, '/system/workers', null)).toBe('platform:workers');
    expect(activeNavKey(admin, '/', null)).toBe('top:home');
  });

  it('matches ?tab= on /connections, defaulting to providers', () => {
    expect(activeNavKey(admin, '/connections', null)).toBe('integrations:models');
    expect(activeNavKey(admin, '/connections', 'mcp')).toBe('integrations:connections');
    expect(activeNavKey(admin, '/connections', 'webhooks')).toBe('integrations:webhooks');
  });

  it('returns null off-nav and labels areas for Ask OCSO', () => {
    expect(activeNavKey(admin, '/nowhere', null)).toBeNull();
    expect(areaLabel('/system/workers')).toBe('system control center');
    expect(areaLabel('/')).toBe('home');
  });
});
