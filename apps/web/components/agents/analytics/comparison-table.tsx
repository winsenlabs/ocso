import Link from 'next/link';
import { DataTable } from '@/components/ui/data-table';
import { SecHead } from '@/components/ui/sec-head';
import { formatDuration, formatNumber, formatPercent } from '@/lib/format';
import type { AgentComparison } from '../data/analytics-schemas';
import { humanizeCode } from '../lib/labels';
import { formatMoneyMicros } from '../lib/metrics';
import { agentHref } from '../lib/tabs';
import { Def } from '../shared/definition';

/** Agent-by-agent comparison with the same formulas (docs/11 §3 "agent-by-agent trends"). */
export function ComparisonTable({ comparison, agentId }: { comparison: AgentComparison; agentId: string }) {
  const d = comparison.definitions;
  const rows = [...comparison.agents].sort((x, y) => y.conversations - x.conversations);
  return (
    <section aria-label="Compared with other agents" style={{ marginBottom: 14 }}>
      <SecHead title="Compared with other agents" count={`${rows.length} agents`} desc={`same formulas · last ${comparison.window.days} days · this agent highlighted`} />
      <DataTable
        label="Agent comparison"
        rows={rows}
        rowKey={(r) => r.agentId}
        selectedKey={agentId}
        template="minmax(0,1.3fr) 76px 92px 92px 80px 90px 70px 90px minmax(0,1fr)"
        columns={[
          {
            key: 'agent',
            header: 'Agent',
            cell: (r) => (
              <Link className="cell-link" href={agentHref(r.agentId, { tab: 'analytics', days: comparison.window.days })}>
                <b style={{ fontSize: 12.5 }}>{r.name}</b>
                <span className="mono-sm" style={{ display: 'block' }}>
                  {r.conversationType.toLowerCase()} · {r.status.toLowerCase()}
                </span>
              </Link>
            ),
          },
          { key: 'convs', header: 'Convs', cell: (r) => <span className="mono">{formatNumber(r.conversations)}</span> },
          { key: 'cont', header: <Def definition={d['containmentRate']}>Contained</Def>, cell: (r) => <span className="mono">{formatPercent(r.containmentRate)}</span> },
          { key: 'esc', header: <Def definition={d['escalationRate']}>Escalated</Def>, cell: (r) => <span className="mono">{formatPercent(r.escalationRate)}</span> },
          { key: 'sla', header: <Def definition={d['slaBreaches']}>SLA</Def>, cell: (r) => <span className="mono">{formatNumber(r.slaBreaches)}</span> },
          { key: 'frt', header: <Def definition={d['firstResponseAiMedianSeconds']}>First resp.</Def>, cell: (r) => <span className="mono">{formatDuration(r.firstResponseAiMedianSeconds)}</span> },
          { key: 'csat', header: <Def definition={d['csat']}>CSAT</Def>, cell: (r) => <span className="mono" title={`${r.csatResponses} responses`}>{formatNumber(r.csat, 2)}</span> },
          { key: 'cost', header: <Def definition={d['costPerConversationMicros']}>Cost/conv</Def>, cell: (r) => <span className="mono">{formatMoneyMicros(r.costPerConversationMicros, r.currency)}</span> },
          { key: 'reason', header: 'Top escalation reason', cell: (r) => <span className="mono-sm">{r.topEscalationReason ? humanizeCode(r.topEscalationReason) : '—'}</span> },
        ]}
      />
    </section>
  );
}
