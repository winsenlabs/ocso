/**
 * Greeting and strip copy for the role homes (design/06), derived from the
 * /v1/home figures. Pure and client-safe; every sentence states a fact the API
 * returned, never an invented one.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pct = (r: number) => `${(r * 100).toFixed(1)}%`;

export interface AdminFacts {
  healthy: number;
  minWarm: number;
  openIncidents: number;
  critical: number;
  providersDegraded: number;
  mcpDegraded: number;
}

export function adminTail(f: AdminFacts): string {
  if (f.healthy === 0) return 'no agent worker is running.';
  if (f.critical > 0) return `${plural(f.critical, 'critical incident is', 'critical incidents are')} open.`;
  if (f.healthy < f.minWarm) return `the runtime is below its warm floor (${f.healthy} of ${f.minWarm}).`;
  const degraded = [f.providersDegraded ? plural(f.providersDegraded, 'provider') : null, f.mcpDegraded ? plural(f.mcpDegraded, 'MCP server') : null].filter(Boolean);
  if (degraded.length) return `the runtime is healthy; ${degraded.join(' and ')} degraded.`;
  if (f.openIncidents > 0) return `the runtime is healthy with ${plural(f.openIncidents, 'open alert')}.`;
  return 'the runtime is healthy.';
}

export interface LeadFacts {
  conversations: number;
  spike: { agentName: string; escalationRate: number; previousRate: number } | null;
  understaffed: string | null;
  slaBreaches: number;
}

export function leadTail(f: LeadFacts): string {
  if (f.spike) return `${f.spike.agentName} is escalating more than last week (${pct(f.spike.escalationRate)} vs ${pct(f.spike.previousRate)}).`;
  if (f.understaffed) return `${f.understaffed} is understaffed right now.`;
  if (f.conversations === 0) return 'no conversations in the last 7 days yet.';
  if (f.slaBreaches > 0) return `${plural(f.slaBreaches, 'SLA breach', 'SLA breaches')} this week.`;
  return 'here is how your agents did this week.';
}

export function execTail(waiting: number): string {
  if (waiting === 0) return 'nobody is waiting on a human.';
  return `${plural(waiting, 'customer is', 'customers are')} waiting on a human.`;
}

/** handoffs.reason_code → label ("ABOVE_AUTHORITY" → "Above authority"). */
export function reasonLabel(code: string): string {
  const words = code.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Other';
}

export type DecisionCopy = { title: string; body: string; tone: 'warn' | 'info'; href: string };

type Decision =
  | { kind: 'prompt_corrections'; agentId: string; agentName: string; open: number; staged: number }
  | { kind: 'understaffed_queue'; queueId: string; queueName: string; waiting: number; onShift: number; members: number }
  | { kind: 'escalation_spike'; agentId: string; agentName: string; escalationRate: number; previousRate: number; conversations: number };

/** "Needs a decision" rail entries (design/06 lead). */
export function decisionCopy(d: Decision): DecisionCopy {
  switch (d.kind) {
    case 'escalation_spike':
      return {
        title: `${d.agentName} is escalating more`,
        body: `${pct(d.escalationRate)} this week vs ${pct(d.previousRate)} the week before · ${plural(d.conversations, 'conversation')}`,
        tone: 'warn',
        href: '/escalation-reasons',
      };
    case 'understaffed_queue':
      return {
        title: `${d.queueName} is understaffed`,
        body: `${d.waiting} waiting · ${d.onShift} of ${d.members} on shift`,
        tone: 'warn',
        href: '/queues',
      };
    case 'prompt_corrections':
      return {
        title: `${plural(d.open + d.staged, 'prompt correction')} for ${d.agentName}`,
        body: `${d.open} open · ${d.staged} staged · review before the next activation`,
        tone: 'info',
        href: '/corrections',
      };
  }
}
