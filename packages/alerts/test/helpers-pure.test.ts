import { describe, expect, it } from 'vitest';
import {
  alertLink,
  atLeastSeverity,
  baselineWindow,
  compareSeverity,
  evaluationWindow,
  fingerprint,
  formatCount,
  formatDurationMs,
  formatMicros,
  formatPercent,
  formatWindow,
  maxSeverity,
  normalizeScopeText,
  renderAlert,
  safeRatio,
  sortBySeverityDesc,
  withinDedupeWindow,
} from '../src/index.js';
import { NOW, message } from './helpers.js';

describe('fingerprint', () => {
  it('is stable across key order and ignores null scope values', () => {
    const a = fingerprint('rule-1', { providerId: 'p1', agentId: 'a1' });
    expect(fingerprint('rule-1', { agentId: 'a1', providerId: 'p1' })).toBe(a);
    expect(fingerprint('rule-1', { agentId: 'a1', providerId: 'p1', extra: null })).toBe(a);
    expect(a).toMatch(/^rule-1:[0-9a-f]{32}$/);
  });

  it('differs by rule and by scope', () => {
    const a = fingerprint('rule-1', { providerId: 'p1' });
    expect(fingerprint('rule-2', { providerId: 'p1' })).not.toBe(a);
    expect(fingerprint('rule-1', { providerId: 'p2' })).not.toBe(a);
    expect(fingerprint('rule-1')).toBe(fingerprint('rule-1', {}));
    expect(normalizeScopeText('  Card   Block ')).toBe('card block');
  });
});

describe('windows', () => {
  it('computes the evaluation and trailing baseline windows', () => {
    expect(evaluationWindow(NOW, 300)).toEqual({ start: new Date('2026-09-22T09:55:00.000Z'), end: NOW });
    expect(baselineWindow(NOW, 300, 12)).toEqual({ start: new Date('2026-09-22T08:55:00.000Z'), end: new Date('2026-09-22T09:55:00.000Z') });
  });

  it('applies the dedupe window only after a recent resolution', () => {
    expect(withinDedupeWindow(null, NOW, 3600)).toBe(false);
    expect(withinDedupeWindow(new Date(NOW.getTime() - 60_000), NOW, 3600)).toBe(true);
    expect(withinDedupeWindow(new Date(NOW.getTime() - 3_601_000), NOW, 3600)).toBe(false);
    expect(withinDedupeWindow(new Date(NOW.getTime() - 1_000), NOW, 0)).toBe(false);
    expect(safeRatio(1, 0)).toBe(0);
    expect(safeRatio(1, 4)).toBe(0.25);
  });
});

describe('severity ordering', () => {
  it('orders INFO < WARNING < CRITICAL', () => {
    expect(compareSeverity('INFO', 'CRITICAL')).toBeLessThan(0);
    expect(atLeastSeverity('CRITICAL', 'WARNING')).toBe(true);
    expect(atLeastSeverity('INFO', 'WARNING')).toBe(false);
    expect(maxSeverity(['INFO', 'CRITICAL', 'WARNING'])).toBe('CRITICAL');
    expect(maxSeverity([])).toBeNull();
    expect(sortBySeverityDesc([{ severity: 'INFO' as const }, { severity: 'CRITICAL' as const }]).map((s) => s.severity)).toEqual(['CRITICAL', 'INFO']);
  });
});

describe('formatting and rendering', () => {
  it('formats values deterministically', () => {
    expect(formatPercent(0.064)).toBe('6.4%');
    expect(formatCount(1234567)).toBe('1,234,567');
    expect(formatDurationMs(850)).toBe('850ms');
    expect(formatDurationMs(2900)).toBe('2.9s');
    expect(formatDurationMs(65_000)).toBe('1m 05s');
    expect(formatWindow(300)).toBe('5m');
    expect(formatWindow(5400)).toBe('1h 30m');
    expect(formatWindow(86_400)).toBe('1d');
    expect(formatMicros(12_340_000)).toBe('12.34 USD');
  });

  it('renders severity as text with fields, footer and link', () => {
    const r = renderAlert(message());
    expect(r.headline).toBe('[CRITICAL] Provider error rate above 5% · AWS Bedrock');
    expect(r.subject).toBe('[OCSO CRITICAL] Provider error rate above 5% · AWS Bedrock');
    expect(r.fields.map((f) => f.label)).toEqual(['Severity', 'Kind', 'Source', 'Value', 'State', 'Opened', 'Occurrences', 'Rule']);
    expect(r.footer).toBe(`OCSO · Meridian Bank · PROD · alert ${message().alertId}`);
    const resolved = renderAlert(message({ event: 'RESOLVED', resolution: 'Auto-resolved', value: null }));
    expect(resolved.headline.startsWith('[RESOLVED]')).toBe(true);
    expect(resolved.body).toContain('Resolution: Auto-resolved');
    expect(resolved.fields.some((f) => f.label === 'Value')).toBe(false);
  });

  it('builds deep links from the public URL', () => {
    expect(alertLink('https://ocso.test/', 'a1')).toBe('https://ocso.test/alerts/a1');
    expect(alertLink(undefined, 'a1')).toBeNull();
  });
});
