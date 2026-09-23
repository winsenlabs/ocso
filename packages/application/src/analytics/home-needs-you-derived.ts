import { Permission, can } from '@ocso/auth';
import type { HomeFlow } from './home-flow.js';
import type { NeedsYouInput, NeedsYouItem } from './home-needs-you.js';
import type { HomeSetup, SetupStepKey } from './home-setup.js';

/**
 * "Needs you" items derived from what Home reads anyway (the service flow and
 * the setup checklist), so their scope is the flow's: channels for channel
 * managers, stuck routing for router managers, queue waits for people who
 * assign work in the queues their teams serve, and the next setup step the
 * person can do themselves.
 */

/** A lead is told about a queue's waiting conversations once the oldest has waited this long (or any is at SLA risk). */
export const QUEUE_WAIT_NOTICE_SECONDS = 10 * 60;

const quote = (s: string) => `“${s}”`;

/** Channels, routing and queues, from the flow already read (so the scope is the flow's). */
export function flowItems(input: NeedsYouInput, flow: HomeFlow | null): NeedsYouItem[] {
  const { principal, now } = input;
  if (!flow) return [];
  const nowIso = now.toISOString();
  const items: NeedsYouItem[] = [];
  if (can(principal, Permission.CHANNELS_MANAGE)) {
    for (const c of flow.channels) {
      if (!c.problem) continue;
      items.push({
        id: `channel:${c.id}`,
        kind: 'channel_down',
        severity: c.problem.includes('turned away') ? 'critical' : 'high',
        title: `Channel ${c.name}: ${c.problem}`,
        detail: `${c.kind} channel`,
        at: nowIso,
        href: '/connections?tab=channels',
        askOcso: `Why is the channel ${quote(c.name)} not working, and how do I fix it?`,
      });
    }
  }
  if (can(principal, Permission.ROUTERS_MANAGE)) {
    for (const r of flow.routers) {
      if (!r.stuck) continue;
      items.push({
        id: `router:${r.id}`,
        kind: 'routing_stuck',
        severity: 'high',
        title: `${r.stuck} ${r.stuck === 1 ? 'conversation is' : 'conversations are'} stuck in router ${r.name}`,
        detail: 'Still routing past the router’s timeout: customers are not reaching a queue.',
        at: r.stuckSince ?? nowIso,
        href: `/routers/${r.id}`,
        askOcso: `Why are conversations stuck in the router ${quote(r.name)}?`,
      });
    }
  }
  if (can(principal, Permission.CONVERSATIONS_ASSIGN)) {
    const mine = new Set(input.queueIds);
    for (const q of flow.queues) {
      // A lead acts on the queues their teams serve (assigning people), not on every queue their agents route to.
      if (!mine.has(q.id) || q.waiting === 0) continue;
      const oldest = q.oldestWaitSeconds ?? 0;
      if (q.slaAtRisk === 0 && oldest < QUEUE_WAIT_NOTICE_SECONDS) continue;
      const started = new Date(now.getTime() - oldest * 1000).toISOString();
      items.push({
        id: `queue:${q.id}`,
        kind: q.slaAtRisk ? 'sla_at_risk' : 'escalation_waiting',
        severity: q.slaAtRisk ? 'high' : 'normal',
        title: q.slaAtRisk ? `${q.slaAtRisk} of ${q.waiting} waiting in ${q.name} at SLA risk` : `${q.waiting} waiting in ${q.name}`,
        detail: `Oldest waiting ${Math.round(oldest / 60)} min`,
        at: started,
        href: '/conversations?view=waiting',
        askOcso: `Why are conversations waiting in ${quote(q.name)}, and who on shift can pick them up?`,
      });
    }
  }
  return items;
}

const SETUP_DOER: Record<SetupStepKey, Permission> = {
  model: Permission.MODEL_PROFILES_MANAGE,
  agent: Permission.AGENTS_MANAGE,
  channel: Permission.CHANNELS_MANAGE,
  second_checker: Permission.USERS_MANAGE,
  go_live: Permission.ROUTERS_MANAGE,
  // deployment.internalAgentProfileId is a non-worker settings section (settings-approval.ts).
  ask_ocso: Permission.DEPLOYMENT_SETTINGS_MANAGE,
};

/** The next setup step this person can do themselves (one item; the checklist card shows the rest). */
export function setupItems(input: NeedsYouInput, setup: HomeSetup | null): NeedsYouItem[] {
  const step = setup?.steps.find((s) => !s.done && can(input.principal, SETUP_DOER[s.key]));
  if (!step || setup?.complete) return [];
  return [
    {
      id: `setup:${step.key}`,
      kind: 'setup',
      severity: 'normal',
      title: step.label,
      detail: 'Next step in setting up this deployment',
      at: input.now.toISOString(),
      href: step.href,
      askOcso: `Help me with this setup step: ${step.label}.`,
    },
  ];
}

