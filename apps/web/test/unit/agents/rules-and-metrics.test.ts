import { describe, expect, it } from 'vitest';
import { absoluteDelta, formatMoneyMicros, pointDelta, relativeDelta, shares } from '../../../components/agents/lib/metrics';
import { buildCondition, buildRule, describeCondition, describeRule, formatRuleValue, parseRuleValue } from '../../../components/agents/lib/rules';

describe('tool argument rules', () => {
  it('parses values per operator', () => {
    expect(parseRuleValue('gt', '5000')).toEqual({ ok: true, value: 5000 });
    expect(parseRuleValue('gte', 'abc').ok).toBe(false);
    expect(parseRuleValue('eq', 'true')).toEqual({ ok: true, value: true });
    expect(parseRuleValue('eq', 'INR')).toEqual({ ok: true, value: 'INR' });
    expect(parseRuleValue('in', 'a, 2, null')).toEqual({ ok: true, value: ['a', 2, null] });
    expect(parseRuleValue('not_in', ' , ').ok).toBe(false);
    expect(parseRuleValue('exists', 'ignored')).toEqual({ ok: true, value: undefined });
  });

  it('builds a rule the API accepts, or explains what is wrong', () => {
    const ok = buildRule({ path: 'payment.amount', op: 'gt', value: '5000', effect: 'REQUIRE_CONFIRMATION', message: 'Needs a human above ₹5,000' });
    expect(ok).toEqual({ ok: true, rule: { path: 'payment.amount', op: 'gt', value: 5000, effect: 'REQUIRE_CONFIRMATION', message: 'Needs a human above ₹5,000' } });
    expect(buildRule({ path: 'bad path', op: 'gt', value: '1', effect: 'DENY', message: 'x' }).ok).toBe(false);
    expect(buildRule({ path: 'amount', op: 'gt', value: '1', effect: 'DENY', message: '  ' }).ok).toBe(false);
    const exists = buildRule({ path: 'override', op: 'exists', value: '', effect: 'DENY', message: 'No overrides' });
    expect(exists.ok && 'value' in exists.rule).toBe(false);
  });

  it('describes rules and round-trips values for editing', () => {
    expect(describeRule({ path: 'amount', op: 'gt', value: 5000, effect: 'REQUIRE_CONFIRMATION', message: 'm' })).toBe('require confirmation when amount > 5000');
    expect(describeRule({ path: 'currency', op: 'not_in', value: ['INR', 'USD'], effect: 'DENY', message: 'm' })).toBe('deny when currency is not one of INR, USD');
    expect(formatRuleValue(['a', 1])).toBe('a, 1');
    expect(formatRuleValue(undefined)).toBe('');
  });
});

describe('escalation conditions', () => {
  it('keeps only filled fields and validates ranges', () => {
    expect(buildCondition({ keywords: 'hardship, job loss', consecutiveToolFailures: '2', customerRequestsHuman: false, amountAbove: '' })).toEqual({
      ok: true,
      condition: { keywords: ['hardship', 'job loss'], consecutiveToolFailures: 2 },
    });
    expect(buildCondition({ keywords: '', consecutiveToolFailures: '11', customerRequestsHuman: false, amountAbove: '' }).ok).toBe(false);
    expect(buildCondition({ keywords: 'x', consecutiveToolFailures: '', customerRequestsHuman: false, amountAbove: '' }).ok).toBe(false);
    expect(buildCondition({ keywords: '', consecutiveToolFailures: '', customerRequestsHuman: true, amountAbove: '5000' })).toEqual({ ok: true, condition: { customerRequestsHuman: true, amountAbove: 5000 } });
  });

  it('summarizes a condition in one line', () => {
    expect(describeCondition({ keywords: ['refund'], amountAbove: 5000 })).toBe('keywords: refund · amount above 5,000');
    expect(describeCondition({})).toBe('');
  });
});

describe('metric deltas', () => {
  it('never turns missing data into a zero', () => {
    expect(pointDelta(null, 0.1)).toBeNull();
    expect(relativeDelta(10, 0)).toBeNull();
    expect(absoluteDelta(3, null)).toBeNull();
  });

  it('formats rate, count and duration changes', () => {
    expect(pointDelta(0.186, 0.168)).toBe('+1.8pt');
    expect(pointDelta(0.8, 0.818)).toBe('−1.8pt');
    expect(relativeDelta(4812, 4531)).toBe('+6.2%');
    expect(absoluteDelta(14, 9)).toBe('+5');
    expect(absoluteDelta(4, 64, 'seconds')).toBe('−1m');
  });

  it('formats model cost without converting currencies', () => {
    expect(formatMoneyMicros(4_800_000, 'INR')).toBe('₹4.80');
    expect(formatMoneyMicros(12_300, 'USD')).toBe('$0.0123');
    expect(formatMoneyMicros(1, 'MIXED')).toBe('mixed currencies');
    expect(formatMoneyMicros(null, 'USD')).toBe('—');
  });

  it('scales bars to the largest value', () => {
    expect(shares([2, 4, 0], (n) => n)).toEqual([0.5, 1, 0]);
    expect(shares([0, 0], (n) => n)).toEqual([0, 0]);
  });
});
