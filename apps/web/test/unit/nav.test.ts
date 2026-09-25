import { describe, expect, it } from 'vitest';
import { permissionsForRole, type Role } from '@ocso/auth';
import { buildNav, homeVariant } from '../../lib/nav';
import { activeNavKey, areaLabel } from '../../lib/nav-active';

const navFor = (role: Role) => buildNav(new Set(permissionsForRole(role)));
const labels = (role: Role) => navFor(role).flatMap((g) => (g.label ? [g.label] : []));
const items = (role: Role) => navFor(role).flatMap((g) => g.items.map((i) => i.label));

describe('buildNav (design/OCSONav.dc.html, derived from permissions)', () => {
  it('gives Service member only "My work"', () => {
    expect(labels('SERVICE')).toEqual(['My work']);
    expect(items('SERVICE')).toEqual(['Home', 'Search', 'Conversations', 'Pickup queue', 'Customers', 'Alerts', 'MCP connections', 'Settings']);
    // Personal accounts only: the entry opens MCP connections, not a separate "My connections" page.
    expect(navFor('SERVICE').find((g) => g.key === 'bottom')?.items.find((i) => i.key === 'mcp')?.href).toBe('/connections?tab=mcp');
  });

  it('gives Head Operations, Quality, Governance and read-only Integrations', () => {
    expect(labels('HEAD')).toEqual(['Operations', 'Quality', 'Governance', 'Integrations']);
    expect(items('HEAD')).toEqual([
      'Home', 'Search',
      'Conversations', 'Virtual agents', 'Queues', 'Routers', 'Customers', 'Message templates',
      'Analytics', 'Reviews', 'Prompt corrections', 'Escalation reasons',
      'Alerts', 'SLA policies', 'Team', 'Approvals', 'Exceptions',
      'Models', 'MCP connections', 'Channels',
      'Settings',
    ]);
  });

  it('gives Lead the same as Head without Exceptions', () => {
    expect(labels('LEAD')).toEqual(['Operations', 'Quality', 'Governance', 'Integrations']);
    expect(items('LEAD')).toEqual(items('HEAD').filter((i) => i !== 'Exceptions'));
  });

  it('gives Tech the full Integrations group and no separate My connections entry', () => {
    expect(navFor('TECH').find((g) => g.key === 'integrations')?.items.map((i) => i.label)).toEqual([
      'Models', 'MCP connections', 'Channels', 'Message templates', 'Secrets', 'Webhooks',
    ]);
    expect(navFor('TECH').find((g) => g.key === 'bottom')?.items.map((i) => i.label)).toEqual(['Settings']);
  });

  it('never lists a destination twice, for any role', () => {
    for (const role of ['TECH', 'HEAD', 'LEAD', 'SERVICE'] as const) {
      const hrefs = navFor(role).flatMap((g) => g.items.map((i) => i.href));
      expect(new Set(hrefs).size, role).toBe(hrefs.length);
      expect(items(role), role).not.toContain('My connections');
    }
    // Message templates sits in Operations for a Head, not again under Integrations.
    expect(navFor('HEAD').find((g) => g.key === 'integrations')?.items.map((i) => i.key)).not.toContain('templates');
  });

  it('gives Tech admin Platform, Integrations and Oversight — no conversation content', () => {
    expect(labels('TECH')).toEqual(['Platform', 'Integrations', 'Oversight']);
    expect(items('TECH')).not.toContain('Conversations');
    expect(items('TECH')).toContain('Team & roles');
    expect(items('TECH')).toContain('Message templates');
    expect(items('SERVICE')).not.toContain('Message templates');
  });

  it('shows Approvals to maker–checker readers in Governance (Head, Lead) and Oversight (Tech), and hides it without approvals.read', () => {
    expect(navFor('HEAD').find((g) => g.key === 'governance')?.items.map((i) => i.key)).toContain('approvals');
    expect(navFor('LEAD').find((g) => g.key === 'governance')?.items.map((i) => i.key)).toContain('approvals');
    expect(navFor('TECH').find((g) => g.key === 'oversight')?.items.map((i) => i.key)).toContain('approvals');
    const withoutRead = new Set(permissionsForRole('HEAD').filter((p) => p !== 'approvals.read'));
    expect(buildNav(withoutRead).flatMap((g) => g.items.map((i) => i.key))).not.toContain('approvals');
  });

  it('shows Exceptions to exceptions.read holders (Head in Governance, Tech in Oversight), not to a Lead', () => {
    expect(navFor('HEAD').find((g) => g.key === 'governance')?.items.map((i) => i.key)).toContain('exceptions');
    expect(navFor('TECH').find((g) => g.key === 'oversight')?.items.map((i) => i.key)).toContain('exceptions');
    expect(navFor('LEAD').flatMap((g) => g.items.map((i) => i.key))).not.toContain('exceptions');
  });

  it('shows Routers to routers.read holders (Lead and Head in Operations, Tech in Oversight), never to Service', () => {
    expect(navFor('LEAD').find((g) => g.key === 'operations')?.items.map((i) => i.key)).toContain('routers');
    expect(navFor('TECH').find((g) => g.key === 'oversight')?.items.map((i) => i.key)).toContain('routers');
    expect(navFor('SERVICE').flatMap((g) => g.items.map((i) => i.key))).not.toContain('routers');
  });

  it('drops items whose permission is missing and empty groups', () => {
    const nav = buildNav(new Set(['analytics.business.read'] as const));
    expect(nav.map((g) => g.key)).toEqual(['top', 'quality', 'bottom']);
    expect(nav.find((g) => g.key === 'quality')?.items.map((i) => i.key)).toEqual(['analytics', 'escalation-reasons']);
  });

  it('picks the role home from permissions', () => {
    expect(homeVariant(new Set(permissionsForRole('SERVICE')))).toBe('exec');
    expect(homeVariant(new Set(permissionsForRole('HEAD')))).toBe('lead');
    expect(homeVariant(new Set(permissionsForRole('TECH')))).toBe('admin');
  });
});

describe('activeNavKey', () => {
  const admin = navFor('TECH');

  it('highlights MCP connections for both of its views', () => {
    expect(activeNavKey(navFor('SERVICE'), '/connections', 'mcp')).toBe('bottom:mcp');
    expect(activeNavKey(navFor('TECH'), '/connections', 'mcp')).toBe('integrations:mcp');
    expect(activeNavKey(navFor('HEAD'), '/connections', 'mcp')).toBe('integrations:mcp');
  });

  it('prefers the longest matching path', () => {
    expect(activeNavKey(admin, '/system', null)).toBe('platform:system');
    expect(activeNavKey(admin, '/system/workers', null)).toBe('platform:workers');
    expect(activeNavKey(admin, '/', null)).toBe('top:home');
  });

  it('matches ?tab= on /connections, defaulting to providers', () => {
    expect(activeNavKey(admin, '/connections', null)).toBe('integrations:models');
    expect(activeNavKey(admin, '/connections', 'mcp')).toBe('integrations:mcp');
    expect(activeNavKey(admin, '/connections', 'webhooks')).toBe('integrations:webhooks');
  });

  it('returns null off-nav and labels areas for Ask OCSO', () => {
    expect(activeNavKey(admin, '/nowhere', null)).toBeNull();
    expect(areaLabel('/system/workers')).toBe('system control center');
    expect(areaLabel('/')).toBe('home');
    expect(areaLabel('/connections')).toBe('integrations');
  });
});
