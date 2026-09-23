import { describe, expect, it } from 'vitest';
import { reconnectDelayMs } from '../../../lib/realtime/backoff';
import { SseParser, formatBlock, parseBlock } from '../../../lib/realtime/sse';
import { isRealtimeEventType } from '../../../lib/realtime/events';
import { channelLabel, channelMark } from '../../../components/workspace/lib/channel';
import { controlLabel, customerDisplayName } from '../../../components/workspace/lib/labels';
import { pickupSla, resolutionLabel, resolutionSla, slaLabel } from '../../../components/workspace/lib/sla';
import { factsOf, fileBadge, formatBytes, riskOf, toolDot, toolMeta } from '../../../components/workspace/lib/timeline';

const T0 = Date.parse('2026-09-22T09:00:00Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

describe('resolution SLA', () => {
  it('runs from opening until resolved, whoever holds the conversation', () => {
    expect(resolutionSla('HUMAN_ACTIVE', at(0), at(14_400), T0 + 3_600_000)).toEqual({ level: 'ok', remainingSeconds: 10_800, progress: 0.25 });
    expect(resolutionSla('AI_ACTIVE', at(0), at(14_400), T0 + 11_000_000)?.level).toBe('risk');
    const overdue = resolutionSla('WAITING_FOR_HUMAN', at(0), at(600), T0 + 700_000)!;
    expect(overdue.level).toBe('breach');
    expect(resolutionLabel(overdue)).toMatch(/^resolution overdue /);
    expect(resolutionSla('RESOLVED', at(0), at(600), T0 + 700_000)).toBeNull();
    expect(resolutionSla('HUMAN_ACTIVE', at(0), null, T0)).toBeNull();
  });
});

describe('pickup SLA (design/01 SLA timers)', () => {
  it('counts down only while the conversation waits for a human', () => {
    expect(pickupSla('WAITING_FOR_HUMAN', at(0), at(900), T0 + 300_000)).toEqual({ level: 'ok', remainingSeconds: 600, progress: 1 / 3 });
    expect(pickupSla('HUMAN_ACTIVE', at(0), at(900), T0)).toBeNull();
    expect(pickupSla('AI_ACTIVE', null, at(900), T0)).toBeNull();
    expect(pickupSla('WAITING_FOR_HUMAN', at(0), null, T0)).toBeNull();
  });

  it('turns amber at 75% of the window and red once breached', () => {
    expect(pickupSla('WAITING_FOR_HUMAN', at(0), at(100), T0 + 80_000)?.level).toBe('risk');
    const breached = pickupSla('ESCALATION_REQUESTED', at(0), at(100), T0 + 198_000)!;
    expect(breached).toMatchObject({ level: 'breach', remainingSeconds: -98, progress: 1 });
    expect(slaLabel(breached)).toBe('breached 01:38');
    expect(slaLabel({ level: 'ok', remainingSeconds: 252, progress: 0.2 })).toBe('04:12 to SLA');
  });
});

describe('channel marks', () => {
  // As GET /v1/channels/kinds returns them: each kind's mark comes from its adapter's descriptor.
  const kinds = [
    { kind: 'TWILIO_WHATSAPP', mark: { code: 'WA', name: 'WhatsApp', tone: 'wa' } },
    { kind: 'TELEGRAM', mark: { code: 'TG', name: 'Telegram' } },
    { kind: 'LEGACY', mark: null },
  ];
  it('takes marks and names from the kind descriptors, for any kind', () => {
    expect(channelMark(kinds, 'TWILIO_WHATSAPP')).toEqual({ code: 'WA', name: 'WhatsApp', tone: 'wa' });
    expect(channelMark(kinds, 'TELEGRAM')?.code).toBe('TG');
    expect(channelMark(kinds, null)).toBeNull();
    expect(channelMark(kinds, 'CARRIER_PIGEON')).toBeNull();
    expect(channelMark([], 'TWILIO_WHATSAPP')).toBeNull();
    expect(channelLabel(kinds, 'TELEGRAM', 'Support bot')).toBe('Telegram');
    expect(channelLabel(kinds, 'CARRIER_PIGEON', 'Pigeon')).toBe('Pigeon');
    expect(channelLabel(kinds, 'LEGACY', null)).toBe('no channel');
  });
});

describe('control labels', () => {
  const me = 'u-me';
  it('says who drives the conversation', () => {
    expect(controlLabel({ controlState: 'HUMAN_ACTIVE', assignedUser: { id: me, name: 'Esha Exec' }, handoff: null }, me)).toBe('You · human');
    expect(controlLabel({ controlState: 'HUMAN_ACTIVE', assignedUser: { id: 'x', name: 'Nikhil Menon' }, handoff: null }, me)).toBe('Nikhil · human');
    expect(controlLabel({ controlState: 'WAITING_FOR_HUMAN', assignedUser: { id: me, name: 'Esha' }, handoff: { status: 'OFFERED' } }, me)).toBe('Offered to you');
    expect(controlLabel({ controlState: 'WAITING_FOR_HUMAN', assignedUser: null, handoff: { status: 'WAITING' } }, me)).toBe('Waiting for human');
    expect(controlLabel({ controlState: 'AI_RESUMING', assignedUser: null, handoff: null }, me)).toBe('Returning to AI');
  });

  it('falls back from customer name to masked identity', () => {
    expect(customerDisplayName({ customer: { name: null, identity: 'web · sess 8f2a' } })).toBe('web · sess 8f2a');
    expect(customerDisplayName({ customer: { name: null, identity: null } })).toBe('Unknown customer');
  });
});

describe('tool event presentation', () => {
  const base = { connectionName: 'core-cards', riskClass: 'SENSITIVE', status: 'SUCCEEDED', actorType: 'AGENT', latencyMs: 1800, confirmedByName: 'Nikhil Menon', decisionReason: null, errorCategory: null };
  it('builds the mono meta line from real fields only', () => {
    expect(toolMeta(base)).toBe('core-cards · sensitive write · confirmed by Nikhil Menon · 1.8s · ok');
    expect(toolMeta({ ...base, riskClass: 'READ', confirmedByName: null, latencyMs: 412 })).toBe('core-cards · read-only · 412ms · ok');
    expect(toolMeta({ ...base, status: 'FAILED', confirmedByName: null, latencyMs: null, errorCategory: 'tool_unavailable' })).toBe('core-cards · sensitive write · failed · tool unavailable');
    expect(toolMeta({ ...base, status: 'DENIED', latencyMs: null })).toBe('core-cards · sensitive write · denied by Nikhil Menon · denied');
  });

  it('maps statuses to dots and risk classes to badges', () => {
    expect(toolDot('SUCCEEDED')).toBe('ok');
    expect(toolDot('RUNNING')).toBe('warn');
    expect(toolDot('DENIED')).toBe('fail');
    expect(riskOf('SENSITIVE')).toBe('2-step');
    expect(riskOf('READ')).toBe('read');
    expect(riskOf('SOMETHING_NEW')).toBe('write');
  });

  it('turns result summaries into facts without nested objects', () => {
    expect(factsOf({ txnId: 'TXN-8841-2290', amount_minor: 1248000, rows: [1, 2, 3], nested: { a: 1 }, none: null })).toEqual([
      { k: 'txn id', v: 'TXN-8841-2290' },
      { k: 'amount minor', v: '1248000' },
      { k: 'rows', v: '3 items' },
    ]);
    expect(factsOf('text')).toEqual([]);
    expect(factsOf({ a: 1, b: 2, c: 3 }, 2)).toHaveLength(2);
  });

  it('labels attachments like the design', () => {
    expect(fileBadge('image/jpeg', 'statement-mar.jpg')).toBe('JPG');
    expect(fileBadge('application/pdf')).toBe('PDF');
    expect(formatBytes(188_416)).toBe('184 KB');
    expect(formatBytes(undefined)).toBeNull();
  });
});

describe('realtime plumbing', () => {
  it('parses SSE blocks across chunk boundaries and skips comments', () => {
    const p = new SseParser();
    expect(p.push('event: ready\ndata: {"at":1}\n\n: keepalive\n\nevent: note.added\nid: e1\nda')).toEqual([{ event: 'ready', data: '{"at":1}', id: null }]);
    expect(p.push('ta: {"noteId":"n"}\n\n')).toEqual([{ event: 'note.added', data: '{"noteId":"n"}', id: 'e1' }]);
    expect(parseBlock(': only a comment')).toBeNull();
  });

  it('round-trips a block for the type-filtering proxy', () => {
    const msg = { event: 'tool.completed', data: '{"a":1}\n{"b":2}', id: 'x' };
    expect(parseBlock(formatBlock(msg).trimEnd())).toEqual(msg);
  });

  it('knows the catalogue event types', () => {
    expect(isRealtimeEventType('agent.response_delta')).toBe(true);
    expect(isRealtimeEventType('ping')).toBe(false);
  });

  it('backs off exponentially to 30 s with jitter', () => {
    const mid = () => 0.5;
    expect([0, 1, 2, 3, 4, 5, 6].map((a) => reconnectDelayMs(a, mid))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(reconnectDelayMs(0, () => 0)).toBe(800);
    expect(reconnectDelayMs(0, () => 1)).toBe(1200);
  });
});
