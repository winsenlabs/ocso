import { describe, expect, it } from 'vitest';
import { Permission } from '@ocso/auth';
import { permittedTabs, resolveTab } from '../../../components/connections/connection-tab';
import { connectionStatus, needsAttention, oauthReasonText, parseStep, serverInfoSummary, stepForStage } from '../../../components/connections/mcp/meta';
import { connectionsHref, idParam, param } from '../../../components/connections/url';

const health = { status: null, latencyMs: null, checkedAt: null };

describe('MCP connection presentation', () => {
  it('resumes the wizard at the connection stage', () => {
    expect(stepForStage('DISCOVER')).toBe('discover');
    expect(stepForStage('AUTHENTICATE')).toBe('auth');
    expect(stepForStage('REVIEW')).toBe('review');
    expect(stepForStage('ACTIVE')).toBe('active');
    expect(parseStep('approve')).toBe('approve');
    expect(parseStep('nope')).toBeNull();
  });

  it('labels status for the health column', () => {
    expect(connectionStatus({ status: 'ACTIVE', stage: 'ACTIVE', health: { ...health, status: 'HEALTHY' } })).toEqual({ tone: 'good', label: 'healthy' });
    expect(connectionStatus({ status: 'AUTH_REQUIRED', stage: 'ACTIVE', health }).label).toBe('auth required');
    expect(connectionStatus({ status: 'PENDING', stage: 'REVIEW', health })).toEqual({ tone: 'accent', label: 'draft · review' });
  });

  it('flags approved connections that are unhealthy or have drifted tools', () => {
    const tools = { total: 3, approved: 2, changed: 0 };
    expect(needsAttention({ status: 'DEGRADED', approvedAt: 'x', tools })).toBe(true);
    expect(needsAttention({ status: 'ACTIVE', approvedAt: 'x', tools: { ...tools, changed: 1 } })).toBe(true);
    expect(needsAttention({ status: 'ACTIVE', approvedAt: 'x', tools })).toBe(false);
    expect(needsAttention({ status: 'DOWN', approvedAt: null, tools })).toBe(false);
  });

  it('turns OAuth callback codes into sentences without echoing unknown text verbatim', () => {
    expect(oauthReasonText('state_mismatch')).toContain('did not match a pending request');
    expect(oauthReasonText('weird_code')).toBe('The authorization did not complete (weird code).');
    expect(oauthReasonText(undefined)).toBe('The authorization did not complete.');
  });

  it('keeps only typed values from untrusted serverInfo', () => {
    const s = serverInfoSummary({ name: 'Meridian', version: 2, capabilities: { tools: {}, '<script>': {} }, instructions: 'x'.repeat(900), authRequired: { reason: 'unauthorized', oauthAvailable: 'yes', authorizationServers: ['https://as', 3] } });
    expect(s.name).toBe('Meridian');
    expect(s.version).toBeNull();
    expect(s.capabilities).toEqual(['tools']);
    expect(s.instructions).toHaveLength(600);
    expect(s.authRequired).toMatchObject({ reason: 'unauthorized', oauthAvailable: false, authorizationServers: ['https://as'] });
  });
});

describe('connections URL state and tabs', () => {
  it('builds and reads the URL', () => {
    expect(connectionsHref({ tab: 'mcp', connection: 'abc', step: undefined })).toBe('/connections?tab=mcp&connection=abc');
    expect(param({ tab: ['mcp', 'x'] }, 'tab')).toBe('mcp');
    expect(idParam({ id: 'not-a-uuid' }, 'id')).toBeUndefined();
    expect(idParam({ id: '0192f0c1-0000-7000-8000-000000000001' }, 'id')).toBe('0192f0c1-0000-7000-8000-000000000001');
  });

  it('offers sections by permission and falls back to the first permitted one', () => {
    const exec = permittedTabs({ permissions: new Set([Permission.MCP_CONNECT_PERSONAL]) });
    expect(exec.map((t) => t.key)).toEqual(['mcp']);
    expect(resolveTab('providers', exec)).toBe('mcp');
    const lead = permittedTabs({ permissions: new Set([Permission.PROVIDERS_READ, Permission.MCP_READ, Permission.CHANNELS_READ, Permission.MCP_CONNECT_PERSONAL]) });
    expect(lead.map((t) => t.key)).toEqual(['providers', 'mcp', 'channels']);
    expect(resolveTab('mcp', lead)).toBe('mcp');
    expect(resolveTab(undefined, [])).toBeNull();
  });
});
