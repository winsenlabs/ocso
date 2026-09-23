import { and, eq, inArray } from 'drizzle-orm';
import type { Principal, Role } from '@ocso/auth';
import { notificationDestinations, virtualAgents, type DbOrTx } from '@ocso/db';
import { validation } from '@ocso/domain';
import { readableAgentFilter } from '../agents/access.js';
import { roleCanReadKind } from './audience.js';
import type { EvaluatorRegistry } from './evaluators/registry.js';
import type { AlertRuleRow } from './views.js';

/** Every configurable field of a rule (what a create stores and an approved change replaces). */
export type AlertRuleFields = Omit<AlertRuleRow, 'id' | 'createdBy' | 'createdAt' | 'updatedAt'>;

/**
 * Validate a complete rule and return normalized, storable fields. `principal`
 * scopes the agent lookup to agents they can read (another team's agent reads
 * as missing, ADR-026); null (an approval activating) checks existence only —
 * the maker's scope was checked when they proposed it.
 */
export async function validateAlertRule(db: DbOrTx, evaluators: EvaluatorRegistry, principal: Principal | null, input: AlertRuleFields): Promise<AlertRuleFields> {
  const evaluator = evaluators.find(input.condition);
  if (!evaluator) throw validation('unknown_condition', `Unknown alert condition "${input.condition}"`);
  if (!evaluator.kinds.includes(input.kind)) {
    throw validation('condition_kind_mismatch', `${input.condition} is a ${evaluator.kinds.join('/').toLowerCase()} condition`);
  }
  if (input.agentId && !evaluator.agentScoped) throw validation('condition_not_agent_scoped', `${input.condition} is platform-wide and cannot target an agent`);
  const params = evaluator.parseParams(input.params);
  if (!params.ok) throw validation('invalid_alert_params', params.problems.join('; '), { problems: params.problems });
  const blind = input.audienceRoles.filter((r) => !roleCanReadKind(r as Role, input.kind));
  if (blind.length) {
    throw validation('audience_cannot_read_kind', `${blind.join(', ')} cannot see ${input.kind.toLowerCase()} alerts`, { roles: blind });
  }
  if (input.agentId) {
    const scope = principal ? readableAgentFilter(principal, virtualAgents.id) : undefined;
    const [agent] = await db.select({ id: virtualAgents.id }).from(virtualAgents).where(and(eq(virtualAgents.id, input.agentId), scope));
    if (!agent) throw validation('unknown_agent', 'The virtual agent does not exist');
  }
  const destinationIds = [...new Set(input.destinationIds)];
  if (destinationIds.length) {
    const found = await db.select({ id: notificationDestinations.id }).from(notificationDestinations).where(inArray(notificationDestinations.id, destinationIds));
    if (found.length !== destinationIds.length) throw validation('unknown_destination', 'One or more notification destinations do not exist');
  }
  return {
    name: input.name,
    kind: input.kind,
    condition: input.condition,
    params: params.params,
    agentId: input.agentId,
    windowSeconds: input.windowSeconds,
    severity: input.severity,
    audienceRoles: [...new Set(input.audienceRoles)],
    destinationIds,
    dedupeWindowSeconds: input.dedupeWindowSeconds,
    autoResolve: input.autoResolve,
    enabled: input.enabled,
  };
}

/** Patch fields over a rule; a condition change resets params unless new ones are supplied. */
export function mergeAlertRule(before: AlertRuleFields, patch: Partial<AlertRuleFields>): AlertRuleFields {
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<AlertRuleFields>;
  const merged: AlertRuleFields = { ...before, ...defined };
  if (patch.condition && patch.condition !== before.condition && patch.params === undefined) merged.params = {};
  return merged;
}
