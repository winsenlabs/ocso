import { describe, expect, it } from 'vitest';
import { permissionsForRole, type Role } from '@ocso/auth';
import { permittedTabs, permittedViews, primaryAction, resolveTab, resolveView } from '../../../components/connections/connection-tab';
import { legacyRedirect } from '../../../lib/legacy-urls';

const grants = (role: Role) => ({ permissions: new Set(permissionsForRole(role)) });
const sections = (role: Role) => permittedTabs(grants(role)).map((s) => s.key);
const views = (role: Role) => permittedViews(grants(role)).map((v) => v.key);

describe('Integrations sections (one per sidebar entry)', () => {
  it('follow permissions per role', () => {
    expect(sections('TECH')).toEqual(['providers', 'mcp', 'channels', 'secrets', 'webhooks']);
    expect(sections('HEAD')).toEqual(['providers', 'mcp', 'channels']);
    expect(sections('LEAD')).toEqual(['providers', 'mcp', 'channels']);
    expect(sections('SERVICE')).toEqual(['mcp']);
  });

  it('gives MCP connections a shared view and a My connections view', () => {
    expect(views('TECH')).toEqual(['shared', 'mine']);
    expect(views('HEAD')).toEqual(['shared', 'mine']);
    expect(views('SERVICE')).toEqual(['mine']);
    expect(resolveView(undefined, permittedViews(grants('TECH')))).toBe('shared');
    expect(resolveView('mine', permittedViews(grants('TECH')))).toBe('mine');
    expect(resolveView('shared', permittedViews(grants('SERVICE')))).toBe('mine');
  });

  it('falls back to the first permitted section', () => {
    expect(resolveTab('providers', permittedTabs(grants('SERVICE')))).toBe('mcp');
    expect(resolveTab('webhooks', permittedTabs(grants('HEAD')))).toBe('providers');
    expect(resolveTab('nope', permittedTabs(grants('TECH')))).toBe('providers');
  });

  it('shows one header action, only to roles that can use it', () => {
    const tech = grants('TECH');
    const head = grants('HEAD');
    const section = (key: string) => permittedTabs(tech).find((s) => s.key === key)!;
    expect(primaryAction(section('providers'), tech, null)?.label).toBe('Add provider');
    expect(primaryAction(section('mcp'), tech, 'shared')?.label).toBe('Add MCP server');
    expect(primaryAction(section('mcp'), tech, 'mine')).toBeNull();
    expect(primaryAction(section('channels'), tech, null)?.label).toBe('Add channel');
    expect(primaryAction(section('secrets'), tech, null)).toBeNull();
    expect(primaryAction(section('webhooks'), tech, null)?.label).toBe('Add endpoint');
    for (const key of ['providers', 'mcp', 'channels']) expect(primaryAction(section(key), head, 'shared'), key).toBeNull();
  });
});

describe('legacyRedirect', () => {
  it('sends the old My connections tab to the MCP connections view, keeping other parameters', () => {
    expect(legacyRedirect('/connections', new URLSearchParams('tab=mine'))).toBe('/connections?tab=mcp&view=mine');
    expect(legacyRedirect('/connections', new URLSearchParams('tab=mine&connection=abc&oauth=ok'))).toBe('/connections?tab=mcp&connection=abc&oauth=ok&view=mine');
  });

  it('leaves current URLs alone', () => {
    expect(legacyRedirect('/connections', new URLSearchParams('tab=mcp'))).toBeNull();
    expect(legacyRedirect('/connections', new URLSearchParams(''))).toBeNull();
    expect(legacyRedirect('/alerts', new URLSearchParams('tab=mine'))).toBeNull();
  });
});
