import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { HBarChart } from '@/components/ui/hbar-chart';
import { RailCard } from '@/components/ui/rail-card';
import { SecHead } from '@/components/ui/sec-head';
import type { HomeData, LeadDecision } from '@/lib/api/home';
import { firstName, formatNumber } from '@/lib/format';
import { hasPermission, type Session } from '@/lib/session';
import { AgentCards } from './agent-cards';
import type { AskChip } from './ask-ocso-bar';
import { HomeFrame } from './home-frame';
import { decisionCopy, leadTail, reasonLabel } from './home-copy';
import { mergeNeedsYou, periodLabel, type NeedsYouLike } from './home-model';
import { QueuesTable } from './queues-table';
import { ServiceFlow } from './service-flow';

type LeadHomeView = Extract<HomeData, { role: 'HEAD' }>;

/** A lead decision (escalation spike, understaffed queue, prompt corrections) as a "needs you" item with a ready question. */
export function decisionItem(d: LeadDecision, at: string): NeedsYouLike {
  const copy = decisionCopy(d);
  const id = d.kind === 'understaffed_queue' ? d.queueId : d.agentId;
  const askOcso =
    d.kind === 'escalation_spike'
      ? `Why is ${d.agentName} escalating more this week than last week?`
      : d.kind === 'understaffed_queue'
        ? `Who could cover ${d.queueName} right now, and how long have its customers been waiting?`
        : `Summarise the open prompt corrections for ${d.agentName}.`;
  return { id: `decision:${d.kind}:${id}`, kind: 'decision', severity: copy.tone === 'warn' ? 'high' : 'normal', title: copy.title, detail: copy.body, at, href: copy.href, askOcso };
}

/**
 * Lead decisions as "needs you" items, minus an understaffed queue the API
 * list already names (`queue:<id>`), so one queue is never two rows.
 */
export function decisionItems(decisions: readonly LeadDecision[], ranked: readonly NeedsYouLike[], at: string): NeedsYouLike[] {
  const ids = new Set(ranked.map((r) => r.id));
  return decisions.filter((d) => !(d.kind === 'understaffed_queue' && ids.has(`queue:${d.queueId}`))).map((d) => decisionItem(d, at));
}

/** Head / Lead Home (HOME decision 3): what needs you, the live service flow of their teams, then agent quality. */
export function LeadHome({ session, home, ask, now }: { session: Session; home: LeadHomeView; ask: AskChip[] | null; now: Date }) {
  const data = home.lead;
  const t = data.tiles;
  const spike = data.decisions.find((d) => d.kind === 'escalation_spike');
  const understaffed = data.decisions.find((d) => d.kind === 'understaffed_queue');
  const live = data.agents.filter((a) => a.status === 'LIVE').length;
  const tail = leadTail({
    conversations: t.conversations,
    spike: spike ? { agentName: spike.agentName, escalationRate: spike.escalationRate, previousRate: spike.previousRate } : null,
    understaffed: understaffed ? understaffed.queueName : null,
    slaBreaches: t.slaBreaches,
  });
  const strip = [`${live} live agent${live === 1 ? '' : 's'}`, `${formatNumber(t.conversations)} conversations this week`, `${formatNumber(t.slaBreaches)} SLA breaches`];
  const needsYou = mergeNeedsYou(home.needsYou, decisionItems(data.decisions, home.needsYou, home.generatedAt));
  const maxReason = Math.max(1, ...data.escalationReasons.map((r) => r.count));

  const reasons = (
    <RailCard title="Escalation reasons · 7d">
      {data.escalationReasons.length ? (
        <HBarChart
          label="Escalation reasons, last 7 days"
          columns="minmax(90px,1fr) minmax(0,1.3fr) 44px"
          rows={data.escalationReasons.map((r, i) => ({
            label: data.escalationReasons.filter((o) => o.reasonCode === r.reasonCode).length > 1 ? `${reasonLabel(r.reasonCode)} · ${r.trigger.toLowerCase()}` : reasonLabel(r.reasonCode),
            share: r.count / maxReason,
            display: formatNumber(r.count),
            tone: r.trigger === 'TOOL_FAILURE' ? 'd' : i < 2 ? 'w' : 'default',
          }))}
        />
      ) : (
        <span className="mono-sm">no agent handoffs in the last 7 days</span>
      )}
    </RailCard>
  );

  return (
    <HomeFrame
      name={firstName(session.user.name)}
      tail={tail}
      strip={strip}
      ask={ask}
      needsYou={needsYou}
      tiles={home.tiles}
      period={periodLabel('HEAD')}
      setup={home.setup}
      permissions={session.permissions}
      now={now}
      rail={reasons}
    >
      {home.flow ? (
        <ServiceFlow
          flow={home.flow}
          links={{
            channels: hasPermission(session, Permission.CHANNELS_READ),
            routers: hasPermission(session, Permission.ROUTERS_READ),
            queues: hasPermission(session, Permission.QUEUES_MANAGE),
            agents: hasPermission(session, Permission.AGENTS_READ) || hasPermission(session, Permission.AGENTS_MANAGE),
          }}
        />
      ) : (
        <>
          <SecHead title="Queues" count={data.queues.length} />
          <QueuesTable rows={data.queues} />
        </>
      )}

      <SecHead
        title="Agent quality"
        count={`${live} live · last 7 days`}
        style={{ marginTop: 22 }}
        actions={
          hasPermission(session, Permission.AGENTS_MANAGE) ? (
            <Link className="btn tiny" href="/agents">
              All agents
            </Link>
          ) : null
        }
      />
      <AgentCards agents={data.agents} />
    </HomeFrame>
  );
}
