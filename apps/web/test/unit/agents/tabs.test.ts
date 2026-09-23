import { describe, expect, it } from 'vitest';
import { Permission, permissionsForRole } from '@ocso/auth';
import { AgentSchema, PromptSchema } from '../../../components/agents/data/agent-schemas';
import { agentPresence, formatDay, shortHash } from '../../../components/agents/lib/labels';
import { agentHref, analyticsDays, permittedAgentTabs, resolveAgentTab } from '../../../components/agents/lib/tabs';

const tabsFor = (role: 'CS_LEAD' | 'CS_EXEC' | 'PLATFORM_TECH_ADMIN') => permittedAgentTabs(new Set(permissionsForRole(role))).map((t) => t.key);

describe('agent tabs by role', () => {
  it('gives the CS Lead every tab', () => {
    expect(tabsFor('CS_LEAD')).toEqual(['overview', 'prompt', 'tools', 'channels', 'routing', 'escalation', 'analytics', 'versions', 'quality', 'settings']);
  });

  it('gives the CS Exec read-only tabs without business analytics, channels or quality', () => {
    expect(tabsFor('CS_EXEC')).toEqual(['overview', 'prompt', 'tools', 'routing', 'escalation', 'versions', 'settings']);
  });

  it('gives the Tech Admin technical tabs, not analytics or quality', () => {
    const tabs = tabsFor('PLATFORM_TECH_ADMIN');
    expect(tabs).toContain('channels');
    expect(tabs).not.toContain('analytics');
    expect(tabs).not.toContain('quality');
  });

  it('falls back to the first permitted tab', () => {
    const tabs = permittedAgentTabs(new Set([Permission.AGENTS_READ]));
    expect(resolveAgentTab('analytics', tabs)).toBe('overview');
    expect(resolveAgentTab('prompt', tabs)).toBe('prompt');
    expect(resolveAgentTab(undefined, [])).toBeNull();
  });
});

describe('agent URLs', () => {
  const id = '0192f1a0-0000-7000-8000-000000000001';
  it('keeps overview as the bare path and encodes the rest', () => {
    expect(agentHref(id)).toBe(`/agents/${id}`);
    expect(agentHref(id, { tab: 'overview' })).toBe(`/agents/${id}`);
    expect(agentHref(id, { tab: 'versions', from: 'a', to: 'b' })).toBe(`/agents/${id}?tab=versions&from=a&to=b`);
    expect(agentHref(id, { tab: 'analytics', days: 30 })).toBe(`/agents/${id}?tab=analytics&days=30`);
  });

  it('accepts only the offered analytics windows', () => {
    expect(analyticsDays('30')).toBe(30);
    expect(analyticsDays('31')).toBe(7);
    expect(analyticsDays(undefined)).toBe(7);
  });
});

describe('labels', () => {
  it('maps agent status to presence', () => {
    expect(agentPresence('LIVE')).toEqual({ state: 'working', label: 'live' });
    expect(agentPresence('PAUSED').label).toBe('paused');
    expect(agentPresence('DRAFT').label).toBe('draft');
  });

  it('shortens hashes and formats days in the deployment timezone', () => {
    expect(shortHash('pv_4f81aa00bb11cc22a20c')).toBe('pv_4f81…a20c');
    expect(shortHash('pv_short')).toBe('pv_short');
    expect(formatDay('2026-03-11T20:00:00Z', 'Asia/Kolkata')).toBe('12 Mar');
    expect(formatDay('2026-01-04T10:00:00Z', 'UTC', true)).toBe('04 Jan 2026');
  });
});

describe('response contracts', () => {
  it('accepts prompt versions from API builds without author names', () => {
    const parsed = PromptSchema.parse({
      components: [],
      dirty: false,
      baseVersionId: null,
      versions: [
        { id: 'v', version: 1, components: {}, promptHash: 'pv_x', runtimeContractVersion: 'rc1', changedComponents: [], parentVersionId: null, reason: 'Initial version', authorId: null, correctionIds: null, evaluationRunId: null, createdAt: '2026-01-01T00:00:00Z', firstActivatedAt: null },
      ],
    });
    expect(parsed.versions[0]?.authorName).toBeNull();
  });

  it('rejects an agent row with an unknown status', () => {
    expect(AgentSchema.safeParse({ status: 'ARCHIVED' }).success).toBe(false);
  });
});
