import type { ArgumentRule, EscalationCondition, RuleOp } from '../data/agent-schemas';

/**
 * Tool argument rules (docs/archive/specs/08 §6) and escalation conditions (docs/archive/specs/01 §6):
 * text-field parsing and one-line summaries. Pure, client-safe. The API
 * validates again (apps/api ArgumentRuleInput / EscalationRuleInput).
 */

export const OP_LABELS: Readonly<Record<RuleOp, string>> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  eq: '=',
  neq: '≠',
  in: 'is one of',
  not_in: 'is not one of',
  exists: 'is present',
};

const RULE_PATH = /^[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9_-]{1,64}){0,7}$/;
type Scalar = string | number | boolean | null;

function scalar(raw: string): Scalar {
  const t = raw.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (t !== '' && Number.isFinite(Number(t))) return Number(t);
  return t;
}

export type ParsedValue = { ok: true; value: unknown } | { ok: false; message: string };

/** Value text as typed in the rule editor → the value the API expects for the operator. */
export function parseRuleValue(op: RuleOp, raw: string): ParsedValue {
  const text = raw.trim();
  switch (op) {
    case 'exists':
      return { ok: true, value: undefined };
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const n = Number(text);
      return text !== '' && Number.isFinite(n) ? { ok: true, value: n } : { ok: false, message: 'Enter a number' };
    }
    case 'eq':
    case 'neq':
      return text === '' ? { ok: false, message: 'Enter a value' } : { ok: true, value: scalar(text) };
    case 'in':
    case 'not_in': {
      const items = text.split(',').map((s) => s.trim()).filter(Boolean);
      if (items.length === 0 || items.length > 100) return { ok: false, message: 'Enter 1–100 comma-separated values' };
      return { ok: true, value: items.map(scalar) };
    }
  }
}

/** The stored value back as editable text. */
export function formatRuleValue(value: unknown): string {
  if (value === undefined) return '';
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ');
  return String(value);
}

export interface RuleDraft {
  path: string;
  op: RuleOp;
  value: string;
  effect: ArgumentRule['effect'];
  message: string;
}

export type BuiltRule = { ok: true; rule: ArgumentRule } | { ok: false; message: string };

export function buildRule(draft: RuleDraft): BuiltRule {
  const path = draft.path.trim();
  if (!RULE_PATH.test(path)) return { ok: false, message: 'Argument path: a dotted name such as payment.amount' };
  const message = draft.message.trim();
  if (!message) return { ok: false, message: 'Explain the rule in a message (shown to whoever confirms)' };
  if (message.length > 300) return { ok: false, message: 'Message: at most 300 characters' };
  const parsed = parseRuleValue(draft.op, draft.value);
  if (!parsed.ok) return { ok: false, message: `Value: ${parsed.message}` };
  const rule: ArgumentRule = { path, op: draft.op, effect: draft.effect, message };
  if (parsed.value !== undefined) rule.value = parsed.value;
  return { ok: true, rule };
}

export function describeRule(rule: ArgumentRule): string {
  const verb = rule.effect === 'DENY' ? 'deny' : 'require confirmation';
  const value = rule.op === 'exists' ? '' : ` ${formatRuleValue(rule.value)}`;
  return `${verb} when ${rule.path} ${OP_LABELS[rule.op]}${value}`;
}

/** One-line summary of an escalation condition ("keywords: refund, dispute · 2 tool failures"). */
export function describeCondition(condition: EscalationCondition): string {
  const parts: string[] = [];
  if (condition.keywords?.length) parts.push(`keywords: ${condition.keywords.join(', ')}`);
  if (condition.consecutiveToolFailures) parts.push(`${condition.consecutiveToolFailures} consecutive tool failures`);
  if (condition.customerRequestsHuman) parts.push('customer asks for a human');
  if (condition.amountAbove !== undefined) parts.push(`amount above ${condition.amountAbove.toLocaleString('en')}`);
  return parts.join(' · ');
}

export interface ConditionDraft {
  keywords: string;
  consecutiveToolFailures: string;
  customerRequestsHuman: boolean;
  amountAbove: string;
}

export type BuiltCondition = { ok: true; condition: EscalationCondition } | { ok: false; message: string };

/** Form fields → EscalationCondition; blank fields are left out. */
export function buildCondition(draft: ConditionDraft): BuiltCondition {
  const condition: EscalationCondition = {};
  const keywords = draft.keywords.split(',').map((k) => k.trim()).filter(Boolean);
  if (keywords.some((k) => k.length < 2 || k.length > 80)) return { ok: false, message: 'Keywords: each 2–80 characters' };
  if (keywords.length > 50) return { ok: false, message: 'Keywords: at most 50' };
  if (keywords.length) condition.keywords = keywords;
  if (draft.consecutiveToolFailures.trim()) {
    const n = Number(draft.consecutiveToolFailures);
    if (!Number.isInteger(n) || n < 1 || n > 10) return { ok: false, message: 'Consecutive tool failures: a whole number from 1 to 10' };
    condition.consecutiveToolFailures = n;
  }
  if (draft.customerRequestsHuman) condition.customerRequestsHuman = true;
  if (draft.amountAbove.trim()) {
    const n = Number(draft.amountAbove);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, message: 'Amount above: a positive number' };
    condition.amountAbove = n;
  }
  return { ok: true, condition };
}
