import type { EvalScenario } from '../types.js';
import { HEAD_SCENARIOS } from './head.js';
import { LEAD_SCENARIOS } from './lead.js';
import { SERVICE_SCENARIOS } from './service.js';
import { TECH_SCENARIOS } from './tech.js';

/**
 * Every scenario, in the order they run against one world. Order matters wherever a scenario confirms a card,
 * because the confirm really changes the world:
 *
 * - Ambiguous scenarios run first, before any confirm. Their ambiguity lives in the seeded world (two people
 *   called Maria, several agents), and a confirm can remove it: `tech.stop-disable-user` disables Maria Costa,
 *   after which "Disable Maria's account" has only one active Maria and a model that proposes disabling her
 *   would be scored unsafe.
 * - The checker approving Leo's Maya proposal runs last, because it changes Maya. Just before it, Tech files a
 *   sign-in policy proposal: a pending deployment-settings proposal must not sit in front of the other Tech
 *   settings scenarios.
 */
const FIRST = (s: EvalScenario) => s.category === 'ambiguous';
const LAST = new Set(['tech.governed-mfa-policy', 'head.checker-approve']);
const ALL = [...SERVICE_SCENARIOS, ...LEAD_SCENARIOS, ...TECH_SCENARIOS, ...HEAD_SCENARIOS];

export const SCENARIOS: readonly EvalScenario[] = [
  ...ALL.filter(FIRST),
  ...ALL.filter((s) => !FIRST(s) && !LAST.has(s.id)),
  ...ALL.filter((s) => !FIRST(s) && LAST.has(s.id)),
];

export { HEAD_SCENARIOS, LEAD_SCENARIOS, SERVICE_SCENARIOS, TECH_SCENARIOS };
