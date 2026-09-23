import type { AskOption, ReturningConfig, RouterRule } from './router-definition.js';

/**
 * Pure matching for routers (PM/research/11 §5.3): a customer's reply against
 * a step's options, collected attributes against the rules, and the
 * returning-customer gap.
 */

/** A customer message as the router sees it: its text and any tapped choice ids (buttons, list rows). */
export interface RouterReply {
  text: string;
  choiceIds: readonly string[];
}

/** Choice ids OCSO puts on buttons: `ocso:<stepId>:<value>`; the returning prompt uses step `returning`. */
export const choiceId = (stepId: string, value: string) => `ocso:${stepId}:${value}`;
export const RETURNING_STEP = 'returning';
export type ReturningChoice = 'continue' | 'new';

export function normalizeReply(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s ]+/g, ' ')
    .replace(/^[\s"'“”‘’.,!?;:()[\]#*-]+|[\s"'“”‘’.,!?;:()[\]#*-]+$/g, '')
    .trim();
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const containsPhrase = (text: string, phrase: string) => phrase.length >= 3 && new RegExp(`(^|[^\\p{L}\\p{N}])${escape(phrase)}($|[^\\p{L}\\p{N}])`, 'u').test(text);

/**
 * The option a reply chooses: a tapped choice id first, then (case-insensitive)
 * the option number, value, label or a synonym, and finally a reply that
 * mentions exactly one option's label, value or synonym. Null when unclear.
 */
export function matchOption(stepId: string, options: readonly AskOption[], reply: RouterReply): AskOption | null {
  for (const id of reply.choiceIds) {
    const hit = options.find((o) => choiceId(stepId, o.value) === id);
    if (hit) return hit;
  }
  const text = normalizeReply(reply.text);
  if (!text) return null;
  if (/^\d{1,2}$/.test(text)) return options[Number(text) - 1] ?? null;
  const terms = (o: AskOption) => [o.value, o.label, ...(o.synonyms ?? [])].map(normalizeReply).filter(Boolean);
  const exact = options.find((o) => terms(o).includes(text));
  if (exact) return exact;
  const mentioned = options.filter((o) => terms(o).some((t) => containsPhrase(text, t)));
  return mentioned.length === 1 ? mentioned[0]! : null;
}

/** Continue or new at the returning-customer prompt (label, 1/2, or the words continue/new). */
export function matchReturning(returning: Pick<ReturningConfig, 'continueLabel' | 'newLabel'>, reply: RouterReply): ReturningChoice | null {
  const options: AskOption[] = [
    { value: 'continue', label: returning.continueLabel, synonyms: ['continue'] },
    { value: 'new', label: returning.newLabel, synonyms: ['new'] },
  ];
  const hit = matchOption(RETURNING_STEP, options, reply);
  return hit ? (hit.value as ReturningChoice) : null;
}

/** First rule whose every key matches the attributes (arrays match any of their values). */
export function evaluateRules(rules: readonly RouterRule[], attributes: Readonly<Record<string, string>>): { index: number; rule: RouterRule } | null {
  for (const [index, rule] of rules.entries()) {
    const matches = Object.entries(rule.when).every(([key, expected]) => {
      const actual = attributes[key];
      if (actual === undefined) return false;
      const wanted = Array.isArray(expected) ? expected : [expected];
      return wanted.some((w) => w.toLowerCase() === actual.toLowerCase());
    });
    if (matches) return { index, rule };
  }
  return null;
}

/** Human text for a rule: `language=ta, product=sales`. */
export function describeRule(rule: RouterRule): string {
  const parts = Object.entries(rule.when).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`);
  return parts.length ? parts.join(', ') : 'always';
}

/** Whether the gap since the customer's last message reaches the returning threshold. */
export function returningDue(askAfter: ReturningConfig['askAfter'], lastCustomerMessageAt: Date | null, now: Date): boolean {
  if (!lastCustomerMessageAt) return false;
  if (askAfter.unit === 'MONTHS') {
    const due = new Date(lastCustomerMessageAt.getTime());
    due.setUTCMonth(due.getUTCMonth() + askAfter.value);
    return now.getTime() >= due.getTime();
  }
  const unitMs = askAfter.unit === 'HOURS' ? 3_600_000 : 86_400_000;
  return now.getTime() - lastCustomerMessageAt.getTime() >= askAfter.value * unitMs;
}
