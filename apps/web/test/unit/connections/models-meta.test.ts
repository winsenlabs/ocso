import { describe, expect, it } from 'vitest';
import type { Capabilities } from '../../../lib/api/models';
import { cacheSettingEffect, cachingMechanism, cachingMode, providerStatus, providerTone, targetReasonText } from '../../../components/connections/models/meta';
import { decimalFromMicros, formatPerMTok, microsFromDecimal } from '../../../components/connections/models/money';

const caps = (promptCaching: Capabilities['promptCaching'], reportsCacheWrites = false): Capabilities => ({
  imageInput: true,
  fileInput: false,
  audioInput: false,
  toolCalling: true,
  structuredOutput: true,
  reasoning: false,
  streaming: true,
  promptCaching,
  reportsCacheWrites,
});

describe('prompt caching per target (ADR-006)', () => {
  it('classifies explicit, implicit, key-based and unverified targets', () => {
    expect(cachingMode('ANTHROPIC', caps('EXPLICIT'))).toBe('explicit');
    expect(cachingMode('BEDROCK', caps('EXPLICIT'))).toBe('explicit');
    expect(cachingMode('VERTEX', caps('AUTOMATIC'))).toBe('implicit');
    expect(cachingMode('OPENAI', caps('AUTOMATIC'))).toBe('key-based');
    expect(cachingMode('FOUNDRY', caps('AUTOMATIC'))).toBe('key-based');
    expect(cachingMode('SARVAM', caps('UNVERIFIED'))).toBe('unverified');
    expect(cachingMode('BEDROCK', caps('UNSUPPORTED'))).toBe('none');
    expect(cachingMode('OPENAI', null)).toBe('unknown');
  });

  it('names the mechanism each adapter uses', () => {
    expect(cachingMechanism('BEDROCK', caps('EXPLICIT'))).toContain('cachePoint');
    expect(cachingMechanism('VERTEX', caps('EXPLICIT'))).toContain('cache_control');
    expect(cachingMechanism('VERTEX', caps('AUTOMATIC'))).toContain('implicit');
    expect(cachingMechanism('OPENAI', caps('AUTOMATIC'))).toBe('automatic + prompt cache key');
    expect(cachingMechanism('OPENAI', caps('AUTOMATIC', true))).toContain('GPT-5.6+');
    expect(cachingMechanism('SARVAM', caps('UNVERIFIED'))).toContain('no documented control');
  });

  it('explains what the profile cache policy and TTL do for each target', () => {
    expect(cacheSettingEffect('ANTHROPIC', caps('EXPLICIT'), 'OFF', '1h')).toContain('off');
    expect(cacheSettingEffect('ANTHROPIC', caps('EXPLICIT'), 'PREFIX', '1h')).toBe('breakpoints · 1h TTL');
    expect(cacheSettingEffect('BEDROCK', caps('EXPLICIT'), 'PREFIX', '1h')).toContain('Claude 4.5+');
    expect(cacheSettingEffect('ANTHROPIC', caps('EXPLICIT'), 'PREFIX', null)).toBe('breakpoints · 5m TTL');
    expect(cacheSettingEffect('OPENAI', caps('AUTOMATIC'), 'PREFIX', '1h')).toBe('cache key · 24h retention');
    expect(cacheSettingEffect('OPENAI', caps('AUTOMATIC', true), 'PREFIX', '1h')).toBe('cache key · 30m implicit retention');
    expect(cacheSettingEffect('VERTEX', caps('AUTOMATIC'), 'PREFIX', '1h')).toContain('managed by the provider');
    expect(cacheSettingEffect('SARVAM', caps('UNVERIFIED'), 'PREFIX', null)).toBe('nothing sent');
  });
});

describe('provider status', () => {
  const stats = { requests: 0, errors: 0, errorRate: null, p95LatencyMs: null, p95TtftMs: null, inputTokens: 0, outputTokens: 0, cacheReadRatio: null, costMicros: null, currency: null };
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
