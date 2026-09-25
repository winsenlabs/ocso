import type { HandoffTrigger, Priority } from '@ocso/domain';

/** An enabled escalation rule as the runtime evaluates it (the agent's rules first, then platform-wide ones). */
export interface ActiveEscalationRule {
  id: string;
  name: string;
  trigger: HandoffTrigger;
  condition: {
    keywords?: string[] | undefined;
    consecutiveToolFailures?: number | undefined;
    customerRequestsHuman?: boolean | undefined;
    amountAbove?: number | undefined;
  };
  priority: Priority;
}

/** What a turn knows when rules are checked. */
export interface EscalationSignals {
  /** The customer messages this turn answers. */
  customerText: string;
  /** Longest run of failed or denied tool calls in the turn. */
  consecutiveToolFailures: number;
  /** The agent's hand-off said the customer asked for a person. */
  customerAskedForHuman: boolean;
}

export interface RuleMatch {
  rule: ActiveEscalationRule;
  /** Why it matched, for the hand-off reason ("rule “Hardship”: keyword “job loss”"). */
  reason: string;
}

/**
 * Deterministic escalation conditions (docs/concepts/virtual-agents.md#escalation-rules). Conditions in one rule are
 * "any that apply". Keywords and amounts are read from the customer's messages, tool failures from the turn;
 * judgement calls stay with the prompt.
 */
export function conditionMatch(rule: ActiveEscalationRule, signals: EscalationSignals): string | null {
  const c = rule.condition;
  for (const keyword of c.keywords ?? []) {
    if (keywordPattern(keyword).test(signals.customerText)) return `keyword “${keyword}”`;
  }
  if (c.amountAbove !== undefined) {
    const limit = c.amountAbove;
    const amount = amountsIn(signals.customerText).find((a) => a > limit);
    if (amount !== undefined) return `amount ${amount.toLocaleString('en')} above ${limit.toLocaleString('en')}`;
  }
  if (c.consecutiveToolFailures && signals.consecutiveToolFailures >= c.consecutiveToolFailures) {
    return `${signals.consecutiveToolFailures} consecutive tool failures`;
  }
  if (c.customerRequestsHuman && signals.customerAskedForHuman) return 'customer asked for a human';
  return null;
}

/** The first rule whose conditions fire: the runtime hands off even if the agent would not. */
export function proactiveRule(rules: readonly ActiveEscalationRule[], signals: EscalationSignals): RuleMatch | null {
  for (const rule of rules) {
    const why = conditionMatch(rule, signals);
    if (why) return { rule, reason: `rule “${rule.name}”: ${why}` };
  }
  return null;
}

/**
 * The rule that routes a hand-off the turn is already making: a rule whose conditions match, else the first rule
 * without conditions for the same trigger (for example, every customer request goes to one queue).
 */
export function ruleForHandoff(rules: readonly ActiveEscalationRule[], trigger: HandoffTrigger, signals: EscalationSignals): RuleMatch | null {
  const matched = proactiveRule(rules, signals);
  if (matched) return matched;
  const general = rules.find((r) => r.trigger === trigger && !hasCondition(r));
  return general ? { rule: general, reason: `rule “${general.name}”` } : null;
}

function hasCondition(rule: ActiveEscalationRule): boolean {
  const c = rule.condition;
  return Boolean(c.keywords?.length || c.consecutiveToolFailures || c.customerRequestsHuman || c.amountAbove !== undefined);
}

/** Whole words, any case; a space in a keyword matches any run of whitespace. */
function keywordPattern(keyword: string): RegExp {
  const body = keyword
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu');
}

const CURRENCY = '(?:₹|rs\\.?|inr|\\$|usd|€|eur|£|gbp|aed|sar|rupees?|dollars?|dirhams?)';
const NUMBER = '(\\d[\\d,]*(?:\\.\\d+)?)';
const AMOUNT = new RegExp(`(?<![\\p{L}])${CURRENCY}\\s?${NUMBER}|${NUMBER}\\s?${CURRENCY}(?![\\p{L}])`, 'giu');

/**
 * Money amounts the customer wrote, only where a currency marks them ("₹50,000", "Rs 12,480", "200 USD"), so card
 * endings, reference numbers and dates never count.
 */
export function amountsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(AMOUNT)) {
    const n = Number((m[1] ?? m[2] ?? '').replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}
