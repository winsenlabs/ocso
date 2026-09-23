import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { HBarChart } from '@/components/ui/hbar-chart';
import { RailCard } from '@/components/ui/rail-card';
import { SecHead } from '@/components/ui/sec-head';
import { Tile, Tiles } from '@/components/ui/tile';
import type { Alert } from '@/lib/api/alerts';
import type { LeadHomeData } from '@/lib/api/home';
import { firstName, formatNumber, formatPercent } from '@/lib/format';
import { hasPermission, type Session } from '@/lib/session';
import { AgentCards } from './agent-cards';
import { AlertList, type RailAlert } from './alert-list';
import { Greeting } from './greeting';
import { decisionCopy, leadTail, reasonLabel } from './home-copy';
import { QueuesTable } from './queues-table';

const warn = (on: boolean) => (on ? { tone: 'warn' as const } : {});

/** Lead home (design/06): 7-day business tiles, virtual agents, queues, decisions and escalation reasons. */
export function LeadHome({ session, data, alerts }: { session: Session; data: LeadHomeData; alerts: Alert[] | null }) {
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
  const strip = [
    `${live} live agent${live === 1 ? '' : 's'}`,
    `${formatNumber(t.conversations)} conversations this week`,
    `${formatNumber(t.slaBreaches)} SLA breaches`,
    `${formatNumber(t.correctionsStaged)} prompt corrections staged`,
  ];
  const decisions: RailAlert[] = data.decisions.map((d, i) => {
    const copy = decisionCopy(d);
    return { key: `${d.kind}-${i}`, title: copy.title, body: copy.body, tone: copy.tone, href: copy.href };
  });
  const businessAlerts: RailAlert[] = (alerts ?? []).map((a) => ({
    key: a.id,
    title: a.title,
    body: [a.value, a.source].filter(Boolean).join(' · '),
    tone: a.severity === 'CRITICAL' ? 'error' : a.severity === 'WARNING' ? 'warn' : 'info',
    href: `/alerts?alert=${a.id}`,
  }));
  const maxReason = Math.max(1, ...data.escalationReasons.map((r) => r.count));

  return (
    <>
      <Greeting name={firstName(session.user.name)} tail={tail} strip={strip} />
      <Tiles>
        <Tile label="conversations 7d" value={formatNumber(t.conversations)} />
        <Tile label="ai containment" value={t.containmentRate === null ? null : formatPercent(t.containmentRate)} />
        <Tile label="escalation rate" value={t.escalationRate === null ? null : formatPercent(t.escalationRate)} {...warn(spike !== undefined)} />
        <Tile label="sla breaches" value={formatNumber(t.slaBreaches)} {...warn(t.slaBreaches > 0)} />
        <Tile label="csat" value={t.csat.average === null ? null : formatNumber(t.csat.average, 2)} />
        <Tile label="corrections staged" value={formatNumber(t.correctionsStaged)} />
      </Tiles>

      <SecHead
        title="Virtual agents"
        count={`${live} live`}
        actions={
          hasPermission(session, Permission.AGENTS_MANAGE) ? (
            <Link className="btn tiny" href="/agents">
              New agent
            </Link>
          ) : null
        }
      />
      <AgentCards agents={data.agents} />

      <div className="row2">
        <div>
          <SecHead title="Queues" count={data.queues.length} />
          <QueuesTable rows={data.queues} />
        </div>
        <div className="rail">
          <RailCard title="Needs a decision" count={decisions.length || undefined}>
            <AlertList items={decisions} empty="nothing needs a decision right now" />
          </RailCard>
          {alerts !== null ? (
            <RailCard title="Business alerts" count={businessAlerts.length || undefined}>
              <AlertList items={businessAlerts} empty="no open business alert" limit={3} />
            </RailCard>
          ) : null}
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
        </div>
      </div>
    </>
  );
}
