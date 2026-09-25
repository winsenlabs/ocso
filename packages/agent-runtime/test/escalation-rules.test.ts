import { describe, expect, it } from 'vitest';
import { amountsIn, proactiveRule, ruleForHandoff, type ActiveEscalationRule } from '../src/turn/escalation-rules.js';

const rule = (name: string, trigger: ActiveEscalationRule['trigger'], condition: ActiveEscalationRule['condition']): ActiveEscalationRule => ({ id: name, name, trigger, condition, priority: 'P3' });
const quiet = { customerText: '', consecutiveToolFailures: 0, customerAskedForHuman: false };

describe('escalation rule conditions', () => {
  it('matches keywords as whole words in any case', () => {
    const rules = [rule('Hardship', 'RISK', { keywords: ['job loss', 'EMI'] })];
    expect(proactiveRule(rules, { ...quiet, customerText: 'I lost my job, loss of income' })).toBeNull();
    expect(proactiveRule(rules, { ...quiet, customerText: 'premium card' })).toBeNull();
    expect(proactiveRule(rules, { ...quiet, customerText: 'my emi is late' })?.reason).toBe('rule “Hardship”: keyword “EMI”');
    expect(proactiveRule([rule('R', 'RISK', { keywords: ['c++'] })], { ...quiet, customerText: 'I use c++ daily' })).not.toBeNull();
  });

  it('reads amounts only with a currency', () => {
    expect(amountsIn('₹50,000 and Rs. 1,200.50 and 300 USD and $5')).toEqual([50000, 1200.5, 300, 5]);
    expect(amountsIn('card 4821, ref TXN-8841-2290, 14 March 2026, 99887766')).toEqual([]);
    expect(amountsIn('users 400 and 20 dollarsign')).toEqual([]);
  });

  it('checks the amount, tool failure and customer request conditions', () => {
    const rules = [rule('Big', 'BUSINESS_RULE', { amountAbove: 10_000 }), rule('Tools', 'TOOL_FAILURE', { consecutiveToolFailures: 3 }), rule('Person', 'CUSTOMER_REQUEST', { customerRequestsHuman: true })];
    expect(proactiveRule(rules, { ...quiet, customerText: 'refund ₹10,000' })).toBeNull();
    expect(proactiveRule(rules, { ...quiet, customerText: 'refund ₹10,001' })?.rule.name).toBe('Big');
    expect(proactiveRule(rules, { ...quiet, consecutiveToolFailures: 2 })).toBeNull();
    expect(proactiveRule(rules, { ...quiet, consecutiveToolFailures: 3 })?.rule.name).toBe('Tools');
    expect(proactiveRule(rules, { ...quiet, customerAskedForHuman: true })?.rule.name).toBe('Person');
  });

  it('routes a hand-off by a matching rule, else by a rule without conditions for its trigger', () => {
    const rules = [rule('Person', 'CUSTOMER_REQUEST', { customerRequestsHuman: true }), rule('Decisions', 'AGENT_DECISION', {})];
    expect(ruleForHandoff(rules, 'AGENT_DECISION', quiet)?.rule.name).toBe('Decisions');
    expect(ruleForHandoff(rules, 'CUSTOMER_REQUEST', { ...quiet, customerAskedForHuman: true })?.rule.name).toBe('Person');
    expect(ruleForHandoff(rules, 'CUSTOMER_REQUEST', quiet)).toBeNull();
    expect(ruleForHandoff(rules, 'SENSITIVE_ACTION', quiet)).toBeNull();
  });
});
