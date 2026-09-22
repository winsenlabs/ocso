import { describe, expect, it } from 'vitest';
import { auditHref, diffRows, parseAuditParams, toApiFilter } from '../../../components/audit/audit-meta';
import { adminTail, decisionCopy, execTail, leadTail, reasonLabel } from '../../../components/home/home-copy';

describe('audit URL model', () => {
  it('parses filters, drops unsafe values and pages with before', () => {
    const p = parseAuditParams({ targetType: 'worker_settings', action: 'alert_rule.', via: 'ui', from: '2026-09-01', to: 'bad', before: '2026-09-20T10:00:00Z', entry: 'x y' });
    expect(p).toEqual({
      targetType: 'worker_settings',
      action: 'alert_rule.',
      via: 'UI',
      actorId: undefined,
      targetId: undefined,
      from: '2026-09-01',
      to: undefined,
      before: '2026-09-20T10:00:00.000Z',
      entry: undefined,
    });
    expect(auditHref({ targetType: 'alert_rule', entry: 'abc' })).toBe('/audit?targetType=alert_rule&entry=abc');
    expect(auditHref({})).toBe('/audit');
  });

  it('turns UTC days into the API window, the earlier of `to` and the page cursor winning', () => {
    const f = toApiFilter({ from: '2026-09-01', to: '2026-09-10', before: '2026-09-05T08:00:00.000Z' }, 100);
    expect(f).toMatchObject({ since: '2026-09-01T00:00:00.000Z', before: '2026-09-05T08:00:00.000Z', limit: 100 });
    expect(toApiFilter({ to: '2026-09-10' }, 50).before).toBe('2026-09-11T00:00:00.000Z');
  });
});

describe('audit before/after diff', () => {
  it('treats a partial patch as the change and the rest of the row as context', () => {
    const rows = diffRows({ id: 1, maxWorkers: 10, minWarmWorkers: 2, updatedAt: 't0' }, { maxWorkers: 12 });
    expect(rows[0]).toEqual({ path: 'maxWorkers', before: '10', after: '12', change: 'changed' });
    expect(rows.filter((r) => r.change === 'context').map((r) => r.path)).toEqual(['id', 'minWarmWorkers', 'updatedAt']);
  });

  it('shows creates as set, deletes as removed and nested objects by path', () => {
    expect(diffRows(null, { name: 'Rule', params: { thresholdPercent: 5 } })).toEqual([
      { path: 'name', before: null, after: 'Rule', change: 'added' },
      { path: 'params.thresholdPercent', before: null, after: '5', change: 'added' },
    ]);
    expect(diffRows({ name: 'Rule' }, null)).toEqual([{ path: 'name', before: 'Rule', after: null, change: 'removed' }]);
    expect(diffRows({ status: 'OPEN', note: 'x' }, { status: 'ACKNOWLEDGED', resolution: 'fixed' }).map((r) => r.change)).toEqual(['changed', 'added', 'removed']);
    expect(diffRows(null, null)).toEqual([]);
  });
});

describe('home greeting copy', () => {
  const healthy = { healthy: 3, minWarm: 2, openIncidents: 0, critical: 0, providersDegraded: 0, mcpDegraded: 0 };
  it('states the admin runtime facts in priority order', () => {
    expect(adminTail(healthy)).toBe('the runtime is healthy.');
    expect(adminTail({ ...healthy, healthy: 0 })).toBe('no agent worker is running.');
    expect(adminTail({ ...healthy, critical: 2, openIncidents: 2 })).toBe('2 critical incidents are open.');
    expect(adminTail({ ...healthy, healthy: 1 })).toBe('the runtime is below its warm floor (1 of 2).');
    expect(adminTail({ ...healthy, providersDegraded: 1 })).toBe('the runtime is healthy; 1 provider degraded.');
    expect(adminTail({ ...healthy, openIncidents: 1 })).toBe('the runtime is healthy with 1 open alert.');
  });

  it('names an escalation spike before anything else for the lead', () => {
    expect(leadTail({ conversations: 100, spike: { agentName: 'Maya', escalationRate: 0.3, previousRate: 0.2 }, understaffed: 'Disputes', slaBreaches: 3 })).toBe(
      'Maya is escalating more than last week (30.0% vs 20.0%).',
    );
    expect(leadTail({ conversations: 0, spike: null, understaffed: null, slaBreaches: 0 })).toBe('no conversations in the last 7 days yet.');
    expect(leadTail({ conversations: 5, spike: null, understaffed: null, slaBreaches: 1 })).toBe('1 SLA breach this week.');
  });

  it('counts waiting customers for the exec and labels reasons and decisions', () => {
    expect(execTail(0)).toBe('nobody is waiting on a human.');
    expect(execTail(1)).toBe('1 customer is waiting on a human.');
    expect(execTail(4)).toBe('4 customers are waiting on a human.');
    expect(reasonLabel('ABOVE_AUTHORITY')).toBe('Above authority');
    expect(decisionCopy({ kind: 'understaffed_queue', queueId: 'q', queueName: 'Disputes', waiting: 3, onShift: 1, members: 5 })).toMatchObject({
      title: 'Disputes is understaffed',
      body: '3 waiting · 1 of 5 on shift',
      href: '/queues',
    });
  });
});
