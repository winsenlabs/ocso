import { describe, expect, it, vi } from 'vitest';
import { comparedWith, flowNeighbours, formatTileValue, kindLabel, mergeNeedsYou, namesOf, periodLabel, trendOf, whenLabel, type NeedsYouLike } from '../../../components/home/home-model';
import { claimNext } from '../../../lib/actions/take-next-order';

vi.mock('server-only', () => ({}));
const { HomeSchema } = await import('../../../lib/api/home');

describe('trend tiles', () => {
  it('formats values by unit and never invents a zero', () => {
    expect(formatTileValue(0.798, '%')).toBe('79.8%');
    expect(formatTileValue(780, 'ms')).toBe('780ms');
    expect(formatTileValue(72, 's')).toBe('1m 12s');
    expect(formatTileValue(4.56, 'score')).toBe('4.6');
    expect(formatTileValue(1234, 'count')).toBe('1,234');
    expect(formatTileValue(0, undefined)).toBe('0');
    expect(formatTileValue(null, 'count')).toBeNull();
  });

  it('colours the direction by whether up is good', () => {
    const period = periodLabel('HEAD');
    expect(trendOf(112, 100, 'up', 'count', period)).toEqual({ direction: 'up', tone: 'good', label: '12%', sr: 'up 12% vs previous 7 days' });
    expect(trendOf(112, 100, 'down', 'count', period)).toMatchObject({ direction: 'up', tone: 'bad' });
    expect(trendOf(88, 100, 'down', 'count', period)).toMatchObject({ direction: 'down', tone: 'good', label: '12%' });
    expect(trendOf(88, 100, 'none', 'count', period)).toMatchObject({ direction: 'down', tone: 'neutral' });
  });

  it('moves percentages in points, counts from zero in absolute terms, and says when there is nothing to compare', () => {
    expect(trendOf(0.3, 0.2, 'down', '%', 'previous 7 days')).toMatchObject({ direction: 'up', tone: 'bad', label: '10 pts', sr: 'up 10 pts vs previous 7 days' });
    expect(trendOf(0.823, 0.8, 'up', '%', 'x').label).toBe('2.3 pts');
    expect(trendOf(5, 0, 'down', 'count', 'yesterday')).toMatchObject({ label: '5', sr: 'up 5 vs yesterday', tone: 'bad' });
    expect(trendOf(90, 0, 'down', 's', 'yesterday').label).toBe('1m 30s');
    expect(trendOf(10, 10, 'up', 'count', 'yesterday')).toMatchObject({ direction: 'flat', tone: 'neutral', label: 'no change' });
    expect(trendOf(10, null, 'up', 'count', 'yesterday')).toMatchObject({ label: null, sr: 'no comparison with yesterday' });
    expect(trendOf(null, 3, 'up', 'count', 'yesterday').label).toBeNull();
    expect(periodLabel('SERVICE')).toBe('yesterday');
    expect(comparedWith('today', 'previous 7 days')).toBe('yesterday');
    expect(comparedWith('7d', 'yesterday')).toBe('previous 7 days');
    expect(comparedWith(undefined, 'yesterday')).toBe('yesterday');
  });
});

const item = (id: string, severity: NeedsYouLike['severity'], kind = 'alert'): NeedsYouLike => ({ id, kind, severity, title: id, at: '2026-09-24T10:00:00Z', href: `/x/${id}` });

describe('needs you', () => {
  it('keeps the API ranking and slots page items in by severity, dropping duplicates', () => {
    const ranked = [item('a', 'critical'), item('b', 'high'), item('c', 'normal')];
    const merged = mergeNeedsYou(ranked, [item('d', 'high'), item('e', 'normal'), item('a', 'normal')]);
    expect(merged.map((i) => i.id)).toEqual(['a', 'b', 'd', 'c', 'e']);
  });

  it('says how long something has waited or when it is due', () => {
    const now = new Date('2026-09-24T10:30:00Z');
    expect(whenLabel({ kind: 'escalation_waiting', at: '2026-09-24T10:08:00Z' }, now)).toBe('waiting 22m');
    expect(whenLabel({ kind: 'sla_at_risk', at: '2026-09-24T10:42:00Z' }, now)).toBe('due in 12m');
    expect(whenLabel({ kind: 'sla_at_risk', at: '2026-09-24T10:00:00Z' }, now)).toBe('overdue 30m');
    expect(whenLabel({ kind: 'grant_expiring', at: '2026-09-27T10:30:00Z' }, now)).toBe('expires in 3d');
    expect(whenLabel({ kind: 'approval_to_decide', at: '2026-09-24T07:30:00Z' }, now)).toBe('3h ago');
    expect(whenLabel({ kind: 'alert', at: 'not a date' }, now)).toBe('');
  });

  it('reads a queue item as its oldest wait, never as an SLA overrun, and stays quiet on snapshot-time items', () => {
    const now = new Date('2026-09-24T10:30:00Z');
    expect(whenLabel({ id: 'queue:q1', kind: 'sla_at_risk', at: '2026-09-24T10:05:00Z' }, now)).toBe('oldest waiting 25m');
    expect(whenLabel({ id: 'queue:q1', kind: 'escalation_waiting', at: '2026-09-24T10:05:00Z' }, now)).toBe('oldest waiting 25m');
    expect(whenLabel({ id: 'conversation:c1', kind: 'sla_at_risk', at: '2026-09-24T10:05:00Z' }, now)).toBe('overdue 25m');
    expect(whenLabel({ id: 'channel:c', kind: 'channel_down', at: now.toISOString() }, now)).toBe('');
    expect(whenLabel({ id: 'decision:understaffed_queue:q', kind: 'decision', at: now.toISOString() }, now)).toBe('');
  });

  it('labels kinds, including ones a newer API adds', () => {
    expect(kindLabel('approval_to_decide')).toBe('approval');
    expect(kindLabel('grant_expiring')).toBe('access');
    expect(kindLabel('model_budget_low')).toBe('model budget low');
  });
});

describe('service flow graph', () => {
  const graph = {
    channels: [{ id: 'web' }, { id: 'wa' }],
    routers: [
      { id: 'r1', channelIds: ['web'] },
      { id: 'r2', channelIds: ['wa', 'gone'] },
    ],
    queues: [
      { id: 'q1', routerIds: ['r1'], agentId: 'maya' },
      { id: 'q2', routerIds: ['r2'], agentId: null },
    ],
    agents: [
      { id: 'maya', queueIds: ['q1'] },
      { id: 'riya', queueIds: ['q2'] },
    ],
  };

  it('lights the whole path through a node, not its siblings', () => {
    const n = flowNeighbours(graph);
    expect([...n.get('c:web')!].sort()).toEqual(['a:maya', 'q:q1', 'r:r1']);
    expect([...n.get('q:q2')!].sort()).toEqual(['a:riya', 'c:wa', 'r:r2']);
    expect([...n.get('a:maya')!].sort()).toEqual(['c:web', 'q:q1', 'r:r1']);
    // A router's unknown channel id is ignored rather than drawn.
    expect(n.has('c:gone')).toBe(false);
  });

  it('names what feeds a node, shortening long lists', () => {
    const byId = new Map([
      ['a', { name: 'Web' }],
      ['b', { name: 'WhatsApp' }],
      ['c', { name: 'Voice' }],
    ]);
    expect(namesOf(['a', 'b'], byId)).toBe('Web, WhatsApp');
    expect(namesOf(['a', 'b', 'c'], byId)).toBe('Web, WhatsApp +1');
    expect(namesOf(['zz'], byId)).toBeNull();
  });
});

describe('take next', () => {
  it("claims the API's next conversation, and on a conflict reads the new next instead of retrying a taken one", async () => {
    const nexts = ['offered-away', 'free'];
    const loads: number[] = [];
    const claimed: string[] = [];
    const res = await claimNext(
      async (attempt) => (loads.push(attempt), nexts[attempt] ?? null),
      async (id) => (claimed.push(id), id === 'free' ? { ok: true } : { ok: false, retry: true, error: new Error('409') }),
    );
    expect(res).toEqual({ ok: true, conversationId: 'free' });
    expect(claimed).toEqual(['offered-away', 'free']);
    expect(loads).toEqual([0, 1]);
  });

  it('says nobody is waiting, or that others took them, and stops on a real failure', async () => {
    expect(
      await claimNext(
        async () => null,
        async () => ({ ok: true }),
      ),
    ).toEqual({ ok: false, reason: 'empty' });
    const taken = await claimNext(
      async (a) => (a === 0 ? 'x' : null),
      async () => ({ ok: false, retry: true, error: null }),
    );
    expect(taken).toEqual({ ok: false, reason: 'conflict' });
    let calls = 0;
    const always = await claimNext(
      async () => 'x',
      async () => (calls++, { ok: false, retry: true, error: null }),
      3,
    );
    expect(always).toEqual({ ok: false, reason: 'conflict' });
    expect(calls).toBe(3);
    const boom = new Error('403');
    const failed = await claimNext(
      async () => 'x',
      async () => ({ ok: false, retry: false, error: boom }),
    );
    expect(failed).toEqual({ ok: false, reason: 'error', error: boom });
  });
});

describe('GET /v1/home schema', () => {
  const exec = {
    tiles: { assignedToMe: 0, waitingForHuman: 0, slaBreached: 0, resolvedToday: 0, myFirstResponseMedianSeconds: null, myCsat7d: { average: null, responses: 0 } },
    shift: { availability: 'AVAILABLE', maxConcurrent: 4, activeConversations: 0, queues: [], languages: [], skills: [] },
    forYou: [],
  };
  const base = { role: 'SERVICE', generatedAt: '2026-09-24T10:00:00Z', user: { id: 'u', name: 'Omar' }, exec };

  it('reads an API without the Home fields as empty lists', () => {
    const home = HomeSchema.parse(base);
    expect(home.needsYou).toEqual([]);
    expect(home.tiles).toEqual([]);
    expect(home.flow).toBeUndefined();
  });

  it('reads the extended Home, tolerating kinds and severities it does not know', () => {
    const home = HomeSchema.parse({
      ...base,
      needsYou: [
        { id: 'approval:1', kind: 'approval_to_decide', severity: 'high', title: 'Review', at: '2026-09-24T09:00:00Z', href: '/approvals?proposal=1', askOcso: 'Review proposal 1' },
        { id: 'x:1', kind: 'something_new', severity: 'urgent', title: 'New', at: '2026-09-24T09:00:00Z', href: '/' },
      ],
      tiles: [{ key: 'resolved', label: 'resolved today', value: 4, unit: 'count', previous: 2, betterWhen: 'up', href: '/conversations' }],
      setup: { complete: false, steps: [{ key: 'model', label: 'Connect a model', done: true, href: '/connections?tab=providers' }] },
      service: { nextAvailable: true },
    });
    expect(home.needsYou.map((i) => i.severity)).toEqual(['high', 'normal']);
    expect(home.tiles[0]!.betterWhen).toBe('up');
    expect(home.role === 'SERVICE' && home.service?.nextAvailable).toBe(true);
  });
});
