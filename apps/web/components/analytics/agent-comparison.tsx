import Link from 'next/link';
import { CellTitle, DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { HBarChart } from '@/components/ui/hbar-chart';
import { ChartCard } from '@/components/ui/rail-card';
import type { AgentComparison, AgentComparisonRow } from '@/lib/api/analytics';
import { formatDuration, formatMoneyMicros, formatNumber, formatPercent, humanizeCode, share } from './metrics';
import { Th } from './parts';

type Refs = Record<string, number>;

const mono = (text: string, warn = false) => (
  <span className="mono" style={warn ? { color: 'var(--warn)', fontWeight: 600 } : undefined}>
    {text}
  </span>
);

function columns(refs: Refs): Column<AgentComparisonRow>[] {
  return [
    {
      key: 'agent',
      header: 'Agent',
      cell: (a) => (
        <CellTitle
          title={<Link href={`/agents/${a.agentId}`}>{a.name}</Link>}
          caption={`${a.conversationType.toLowerCase()} · ${a.status.toLowerCase()}${a.topEscalationReason ? ` · top reason ${humanizeCode(a.topEscalationReason).toLowerCase()}` : ''}`}
        />
      ),
    },
    { key: 'convs', header: 'Convs', cell: (a) => mono(formatNumber(a.conversations)) },
    { key: 'contained', header: <Th note={refs['agents.containmentRate']}>Contained</Th>, cell: (a) => mono(formatPercent(a.containmentRate)) },
    {
      key: 'escalated',
      header: <Th note={refs['agents.escalationRate']}>Escalated</Th>,
      cell: (a) => (
        <span className="mono">
          {formatPercent(a.escalationRate)}
          <span className="mono-sm" style={{ display: 'block' }}>
            {a.escalated} conv{a.escalated === 1 ? '' : 's'}
          </span>
        </span>
      ),
    },
    { key: 'resolved', header: <Th note={refs['agents.resolutionRate']}>Resolved</Th>, cell: (a) => mono(formatPercent(a.resolutionRate)) },
    { key: 'sla', header: <Th note={refs['agents.slaBreaches']}>SLA br.</Th>, cell: (a) => mono(formatNumber(a.slaBreaches), a.slaBreaches > 0) },
    { key: 'frt', header: <Th note={refs['agents.firstResponseAiMedianSeconds']}>1st resp.</Th>, cell: (a) => mono(formatDuration(a.firstResponseAiMedianSeconds)) },
    {
      key: 'csat',
      header: <Th note={refs['agents.csat']}>CSAT</Th>,
      cell: (a) => (
        <span className="mono">
          {a.csat === null ? '—' : formatNumber(a.csat, 2)}
          {a.csatResponses ? <span className="mono-sm" style={{ display: 'block' }}>n {a.csatResponses}</span> : null}
        </span>
      ),
    },
    { key: 'tools', header: <Th note={refs['agents.toolFailureRate']}>Tool fail</Th>, cell: (a) => mono(formatPercent(a.toolFailureRate), (a.toolFailureRate ?? 0) >= 0.05) },
    { key: 'cost', header: <Th note={refs['agents.costPerConversationMicros']}>Cost / conv</Th>, cell: (a) => mono(formatMoneyMicros(a.costPerConversationMicros, a.currency)) },
  ];
}

/** Agent-by-agent KPIs (GET /v1/analytics/agents), same formulas as the overview tiles. */
export function AgentComparisonTable({ comparison, refs }: { comparison: AgentComparison; refs: Refs }) {
  return (
    <div className="ops-scroll">
      <DataTable
        label="Agent comparison"
        columns={columns(refs)}
        rows={comparison.agents}
        rowKey={(a) => a.agentId}
        template="minmax(160px,1.6fr) 54px 74px 78px 70px 56px 70px 62px 64px 84px"
        empty={<EmptyState title="No virtual agents">Each virtual agent gets a row here once it exists.</EmptyState>}
      />
    </div>
  );
}

/** "Which agent is escalating the most" (escalationRanking). */
export function EscalationRanking({ comparison, days }: { comparison: AgentComparison; days: number }) {
  const rows = comparison.escalationRanking;
  const max = Math.max(0, ...rows.map((r) => r.escalated));
  return (
    <ChartCard title="Escalating the most" meta={<span className="mono-sm">escalated convs · rate</span>}>
      {rows.length ? (
        <>
          <HBarChart
            label="Agents by escalated conversations"
            columns="minmax(80px,1fr) minmax(0,1.2fr) 70px"
            rows={rows.slice(0, 6).map((r) => ({ label: r.name, share: share(r.escalated, max), display: `${r.escalated} · ${formatPercent(r.escalationRate, 0)}`, tone: 'w' }))}
          />
          <div className="foot">
            <Link className="mono-sm" href={`/escalation-reasons?days=${days}`}>
              why they escalate →
            </Link>
          </div>
        </>
      ) : (
        <span className="mono-sm">no escalations in the window</span>
      )}
    </ChartCard>
  );
}
