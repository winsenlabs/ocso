import { describe, expect, it } from 'vitest';
import type { PromptCaching } from '../../../lib/api/models';
import {
  cacheSettingEffect,
  cachingMechanism,
  cachingMode,
  cachingSummary,
  providerMark,
  providerStatus,
  providerTone,
  targetReasonText,
} from '../../../components/connections/models/meta';
import { decimalFromMicros, formatPerMTok, microsFromDecimal } from '../../../components/connections/models/money';

/** As the API sends it: each provider definition words its own caching (packages/model-providers). */
const explicitBedrock: PromptCaching = {
  mode: 'explicit',
  mechanism: 'explicit cachePoint breakpoints (≤ 4)',
  effect: { '5m': 'breakpoints · 5m TTL', '1h': 'breakpoints · 5m TTL (1h needs Claude 4.5+)' },
};
const keyBased: PromptCaching = { mode: 'key-based', mechanism: 'automatic + prompt cache key', effect: { '5m': 'cache key · default retention', '1h': 'cache key · 24h retention' } };

describe('prompt caching per target (ADR-006), as the provider describes it', () => {
  it('shows the mode and mechanism the API sends; unknown when nothing describes the target', () => {
    expect(cachingMode(explicitBedrock)).toBe('explicit');
    expect(cachingMode(keyBased)).toBe('key-based');
    expect(cachingMode({ ...keyBased, mode: 'semantic' })).toBe('semantic');
    expect(cachingMode(null)).toBe('unknown');
    expect(cachingMechanism(explicitBedrock)).toContain('cachePoint');
    expect(cachingMechanism(null)).toMatch(/^unknown/);
  });

  it('explains what the profile cache policy and TTL do for each target', () => {
    expect(cacheSettingEffect(explicitBedrock, 'OFF', '1h')).toContain('off');
    expect(cacheSettingEffect(explicitBedrock, 'PREFIX', '1h')).toContain('Claude 4.5+');
    expect(cacheSettingEffect(explicitBedrock, 'PREFIX', null)).toBe('breakpoints · 5m TTL');
    expect(cacheSettingEffect(keyBased, 'PREFIX', '1h')).toBe('cache key · 24h retention');
    expect(cacheSettingEffect(keyBased, 'PREFIX', '5m')).toBe('cache key · default retention');
    expect(cacheSettingEffect(null, 'PREFIX', null)).toBe('nothing sent');
  });
});

describe('provider marks and caching summaries come from the kinds endpoint', () => {
  it('uses the definition mark, else a generic one derived from the kind', () => {
    expect(providerMark('OPENAI', { mark: 'OAI' })).toBe('OAI');
    expect(providerMark('MISTRAL', undefined)).toBe('MIS');
    expect(providerMark('X_1', {})).toBe('X1');
    expect(providerMark('__', undefined)).toBe('?');
    expect(cachingSummary({ cachingSummary: 'automatic · prompt cache key' })).toBe('automatic · prompt cache key');
    expect(cachingSummary(undefined)).toBe('not described by this deployment');
  });
});

describe('provider status', () => {
  const stats = { requests: 0, errors: 0, errorRate: null, p95LatencyMs: null, p95TtftMs: null, inputTokens: 0, outputTokens: 0, cacheReadRatio: null, costMicros: null, currency: null, unpricedRequests: 0 };
  it('maps health, availability and enablement', () => {
    expect(providerStatus({ enabled: true, available: true, status: 'OK' })).toEqual({ tone: 'good', label: 'connected' });
    expect(providerStatus({ enabled: true, available: true, status: 'UNTESTED' }).label).toBe('untested');
    expect(providerStatus({ enabled: false, available: true, status: 'OK' }).label).toBe('disabled');
    expect(providerStatus({ enabled: true, available: false, status: 'OK' }).label).toBe('not available');
    expect(providerTone({ enabled: true, available: true, status: 'DOWN', stats24h: stats })).toBe('danger');
    expect(providerTone({ enabled: true, available: true, status: 'OK', stats24h: { ...stats, errors: 2 } })).toBe('warn');
    expect(providerTone({ enabled: true, available: true, status: 'OK', stats24h: stats })).toBeUndefined();
  });

  it('explains policy rejections', () => {
    expect(targetReasonText('missing_capability:imageInput')).toBe('lacks imageInput');
    expect(targetReasonText('cross_region_forbidden')).toBe('cross-region fallback is off');
    expect(targetReasonText(null)).toBe('permitted');
    expect(targetReasonText('something_new')).toBe('something new');
  });
});

describe('prices per 1M tokens (micro-units)', () => {
  it('parses and formats decimal amounts exactly', () => {
    expect(microsFromDecimal('3')).toBe(3_000_000);
    expect(microsFromDecimal('0.075')).toBe(75_000);
    expect(microsFromDecimal('15.25')).toBe(15_250_000);
    expect(microsFromDecimal(' ')).toBeNull();
    expect(microsFromDecimal('-1')).toBeNaN();
    expect(microsFromDecimal('1.2345678')).toBeNaN();
    expect(decimalFromMicros(3_000_000)).toBe('3.00');
    expect(decimalFromMicros(75_000)).toBe('0.075');
    expect(decimalFromMicros(null)).toBe('');
    expect(formatPerMTok(300_000, 'USD')).toBe('0.30 USD');
    expect(formatPerMTok(null, 'USD')).toBe('—');
  });
});
