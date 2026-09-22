import { describe, expect, it } from 'vitest';
import { alertsHref, parseAlertsParams, windowLabel } from '../../../components/alerts/alerts-meta';
import { buildParams, initialParamText, paramFields, paramLabel } from '../../../components/alerts/rule-params';

const ID = '0192f7a4-5b6c-7d8e-9f01-23456789abcd';

describe('alerts URL model', () => {
  it('parses filters safely and defaults to the unresolved inbox', () => {
    expect(parseAlertsParams({})).toMatchObject({ tab: 'inbox', status: 'UNRESOLVED', kind: undefined, alert: undefined });
    expect(parseAlertsParams({ tab: 'rules', status: 'resolved', kind: 'business', severity: 'critical', alert: ID })).toMatchObject({
      tab: 'rules',
      status: 'RESOLVED',
      kind: 'BUSINESS',
      severity: 'CRITICAL',
      alert: ID,
    });
    expect(parseAlertsParams({ tab: 'nope', status: 'x', alert: 'not-an-id', rule: 'drop table', cursor: 'bad cursor!' })).toMatchObject({
      tab: 'inbox',
      status: 'UNRESOLVED',
      alert: undefined,
      rule: undefined,
      cursor: undefined,
    });
    expect(parseAlertsParams({ rule: 'new', destination: ID })).toMatchObject({ rule: 'new', destination: ID });
  });

  it('builds links that round-trip and omit defaults', () => {
    expect(alertsHref({ tab: 'inbox', status: 'UNRESOLVED' })).toBe('/alerts');
    const href = alertsHref({ status: 'ACKNOWLEDGED', kind: 'TECHNICAL', alert: ID });
    expect(href).toBe(`/alerts?status=acknowledged&kind=technical&alert=${ID}`);
    const back = parseAlertsParams(Object.fromEntries(new URL(href, 'http://x').searchParams));
    expect(back).toMatchObject({ status: 'ACKNOWLEDGED', kind: 'TECHNICAL', alert: ID });
    expect(alertsHref({ tab: 'rules', rule: 'new', kind: 'BUSINESS' })).toBe('/alerts?tab=rules&kind=business&rule=new');
  });

  it('labels windows compactly', () => {
    expect(windowLabel(300)).toBe('5m');
    expect(windowLabel(3600)).toBe('1h');
    expect(windowLabel(86_400)).toBe('1d');
    expect(windowLabel(90)).toBe('90s');
  });
});

describe('rule params from the evaluator JSON Schema', () => {
  const schema = {
    type: 'object',
    properties: {
      topic: { type: 'string', enum: ['conversation.turn', 'channel.deliver'], default: 'conversation.turn' },
      thresholdSeconds: { type: 'number', exclusiveMinimum: 0, maximum: 86400, default: 30 },
      minRequests: { type: 'integer', minimum: 1, default: 20 },
      includePersonal: { type: 'boolean', default: false },
      statuses: { type: 'array', items: { type: 'string', enum: ['DEGRADED', 'DOWN'] }, default: ['DEGRADED', 'DOWN'] },
      minimum: { type: 'integer', minimum: 0 },
    },
  };

  it('derives one field per property with kinds, bounds and defaults', () => {
    const fields = paramFields(schema);
    expect(fields.map((f) => [f.name, f.kind, f.defaultText])).toEqual([
      ['topic', 'enum', 'conversation.turn'],
      ['thresholdSeconds', 'number', '30'],
      ['minRequests', 'integer', '20'],
      ['includePersonal', 'boolean', 'false'],
      ['statuses', 'enum-list', 'DEGRADED, DOWN'],
      ['minimum', 'integer', ''],
    ]);
    expect(fields[1]).toMatchObject({ min: 0, max: 86400, label: 'Threshold seconds' });
    expect(paramLabel('thresholdPercent')).toBe('Threshold percent');
  });

  it('prefers stored params, converts types and omits blanks so the API applies defaults', () => {
    const fields = paramFields(schema);
    const text = initialParamText(fields, { thresholdSeconds: 45, statuses: ['DOWN'] });
    expect(text).toMatchObject({ thresholdSeconds: '45', statuses: 'DOWN', topic: 'conversation.turn', minimum: '' });
    expect(buildParams(fields, text)).toEqual({
      ok: true,
      params: { topic: 'conversation.turn', thresholdSeconds: 45, minRequests: 20, includePersonal: false, statuses: ['DOWN'] },
    });
    expect(buildParams(fields, { ...text, minRequests: '2.5', thresholdSeconds: 'abc' })).toEqual({
      ok: false,
      errors: { minRequests: 'Enter a whole number', thresholdSeconds: 'Enter a number' },
    });
  });
});

