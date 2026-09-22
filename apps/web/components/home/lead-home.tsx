import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { EmptyState } from '@/components/ui/empty-state';
import { HBarChart } from '@/components/ui/hbar-chart';
import { RailCard } from '@/components/ui/rail-card';
import { SecHead } from '@/components/ui/sec-head';
import { Tile, Tiles } from '@/components/ui/tile';
import { loadAgentSummaries, loadEscalationReasons, loadLeadMetrics, type EscalationReason } from '@/lib/api/agents';
import { loadOpenAlerts } from '@/lib/api/alerts';
import { loadQueueSummaries } from '@/lib/api/queues';
import { firstName, formatNumber, formatPercent } from '@/lib/format';
import { hasPermission, type Session } from '@/lib/session';
import { AgentCards } from './agent-cards';
import { AlertList } from './alert-list';
import { Greeting } from './greeting';
import { QueuesTable } from './queues-table';

/** CS Lead home (design/06): business metrics, virtual agents, queues and decisions. */
export async function LeadHome({ session, facts }: { session: Session; facts: string[] }) {
  const [metrics, agents, queues, alerts, reasons] = await Promise.all([
    loadLeadMetrics(),
    loadAgentSummaries(),
    loadQueueSummaries(),
    loadOpenAlerts(),
    loadEscalationReasons(),
  ]);
  const tail = metrics ? 'here is how your agents are doing this week.' : 'agent performance appears here once conversations are flowing.';

  return (
    <>
      <Greeting name={firstName(session.user.name)} tail={tail} strip={facts} />
      <Tiles>
        <Tile label="conversations 7d" value={metrics ? formatNumber(metrics.conversations7d) : null} />
        <Tile label="ai containment" value={metrics ? formatPercent(metrics.containmentRate) : null} />
        <Tile label="escalation rate" value={metrics ? formatPercent(metrics.escalationRate) : null} />
        <Tile label="sla breaches" value={metrics ? formatNumber(metrics.slaBreaches) : null} {...(metrics && metrics.slaBreaches > 0 ? { tone: 'warn' as const } : {})} />
        <Tile label="csat" value={metrics ? formatNumber(metrics.csat, 2) : null} />
        <Tile label="corrections staged" value={metrics ? formatNumber(metrics.correctionsStaged) : null} />
      </Tiles>

      <SecHead
        title="Virtual agents"
        count={agents ? `${agents.filter((a) => a.state !== 'paused').length} live` : 'no data yet'}
        actions={
          hasPermission(session, Permission.AGENTS_MANAGE) ? (
            <Link className="btn tiny" href="/agents">
              New agent
            </Link>
          ) : null
        }
      />
      <AgentCards agents={agents} />

      <div className="row2">
        <div>
          <SecHead title="Queues" count={queues ? queues.length : 'no data yet'} />
          <QueuesTable rows={queues} />
        </div>
        <div className="rail">
          <RailCard title="Needs a decision" count={alerts ? alerts.length : undefined}>
            <AlertList alerts={alerts} emptyText="Business alerts that need a lead's decision — escalation spikes, SLA breaches, staged corrections — will appear here." />
          </RailCard>
          <RailCard title="Escalation reasons · 7d">
            <EscalationReasons reasons={reasons} />
          </RailCard>
        </div>
      </div>
    </>
  );
}

function EscalationReasons({ reasons }: { reasons: EscalationReason[] | null }) {
  if (reasons === null) {
    return (
      <EmptyState size="sm" title="No data yet">
        Why agents hand off to humans, ranked by volume.
      </EmptyState>
    );
  }
  if (reasons.length === 0) return <span className="mono-sm">no handoffs in the last 7 days</span>;
  const max = Math.max(...reasons.map((r) => r.count));
  const tone = { default: 'default', warn: 'w', danger: 'd' } as const;
  return (
    <HBarChart
      label="Escalation reasons, last 7 days"
      columns="minmax(90px,1fr) minmax(0,1.3fr) 44px"
      rows={reasons.map((r) => ({ label: r.reason, share: max ? r.count / max : 0, display: formatNumber(r.count), tone: tone[r.tone] }))}
    />
  );
}
