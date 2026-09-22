import type { ArgumentRule } from './types.js';

/** Read a dotted path (`payment.amount`) from a plain object. */
export function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** True when the rule's condition holds for the given arguments. */
export function ruleMatches(rule: ArgumentRule, args: unknown): boolean {
  const actual = readPath(args, rule.path);
  switch (rule.op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'eq':
      return actual === rule.value;
    case 'neq':
      return actual !== rule.value;
    case 'in':
      return Array.isArray(rule.value) && rule.value.includes(actual);
    case 'not_in':
      return Array.isArray(rule.value) && !rule.value.includes(actual);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toNumber(actual);
      const b = toNumber(rule.value);
      // A numeric guard on a missing/non-numeric value fails closed: treat as matched.
      if (a === null || b === null) return true;
      if (rule.op === 'gt') return a > b;
      if (rule.op === 'gte') return a >= b;
      if (rule.op === 'lt') return a < b;
      return a <= b;
    }
  }
}

export function evaluateArgumentRules(
  rules: readonly ArgumentRule[],
  args: unknown,
): { deny: ArgumentRule | null; confirm: ArgumentRule | null } {
  let confirm: ArgumentRule | null = null;
  for (const rule of rules) {
    if (!ruleMatches(rule, args)) continue;
    if (rule.effect === 'DENY') return { deny: rule, confirm: null };
    confirm ??= rule;
  }
  return { deny: null, confirm };
}
