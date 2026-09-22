import type { ActorContext } from '@ocso/application';
import { queues, slaPolicies } from '@ocso/db';
import type { SeedContext } from '../context.js';
import { QUEUES, SLA_POLICIES, type QueueKey, type SlaKey, type TeamKey } from '../data/organization.js';

/** SLA policies and queues (design/02 Routing tab, design/06 Queues table). Matched by name. */
export async function seedRouting(ctx: SeedContext, lead: ActorContext, teamIds: Record<TeamKey, string>): Promise<Record<QueueKey, string>> {
  const existingPolicies = await ctx.db.select({ id: slaPolicies.id, name: slaPolicies.name }).from(slaPolicies);
  const slaIds = {} as Record<SlaKey, string>;
  for (const [key, policy] of Object.entries(SLA_POLICIES) as Array<[SlaKey, (typeof SLA_POLICIES)[SlaKey]]>) {
    const found = existingPolicies.find((p) => p.name === policy.name);
    slaIds[key] = found?.id ?? (await ctx.services.queues.saveSlaPolicy(lead, null, { ...policy, atRiskFraction: 0.75 }));
  }

  const existingQueues = await ctx.db.select({ id: queues.id, name: queues.name }).from(queues);
  const queueIds = {} as Record<QueueKey, string>;
  for (const [key, queue] of Object.entries(QUEUES) as Array<[QueueKey, (typeof QUEUES)[QueueKey]]>) {
    const found = existingQueues.find((q) => q.name === queue.name);
    if (found) {
      queueIds[key] = found.id;
      continue;
    }
    queueIds[key] = await ctx.services.queues.create(lead, {
      name: queue.name,
      description: queue.description,
      mode: queue.mode,
      autoAssignAfterSeconds: queue.autoAssignAfterSeconds,
      acceptTimeoutSeconds: 120,
      requiredSkills: queue.requiredSkills,
      languages: queue.languages,
      preferAccountOwner: true,
      slaPolicyId: slaIds[queue.sla],
      teamIds: queue.teams.map((t) => teamIds[t]),
    });
    ctx.log(`created queue ${queue.name} (${queue.mode})`);
  }
  return queueIds;
}
