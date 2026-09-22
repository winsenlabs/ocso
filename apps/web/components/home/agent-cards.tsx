import Link from 'next/link';
import { Avatar } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/empty-state';
import { MetricMatrix } from '@/components/ui/metric-matrix';
import { Presence, type PresenceState } from '@/components/ui/presence';
import { StatusChip } from '@/components/ui/status-chip';
import type { AgentSummary } from '@/lib/api/agents';
import { formatNumber, formatPercent, initials } from '@/lib/format';

const PRESENCE: Record<AgentSummary['state'], { state: PresenceState; label: string }> = {
  live: { state: 'working', label: 'live' },
  paused: { state: 'paused', label: 'paused' },
  sla_risk: { state: 'blocked', label: 'sla risk' },
};

/** Virtual agent cards (design/06 .agcard). */
export function AgentCards({ agents }: { agents: AgentSummary[] | null }) {
  if (agents === null) {
    return (
      <div style={{ marginBottom: 18 }}>
        <EmptyState title="No agent metrics yet">
          Each virtual agent&apos;s conversations, AI containment, CSAT and open alerts will appear here once the agents API is live.
        </EmptyState>
      </div>
    );
  }
  if (agents.length === 0) {
    return (
      <div style={{ marginBottom: 18 }}>
        <EmptyState title="No virtual agents yet">Create a virtual agent to start handling conversations.</EmptyState>
      </div>
    );
  }
  return (
    <div className="g g3" style={{ marginBottom: 18 }}>
      {agents.map((a) => (
        <AgentCard key={a.id} agent={a} />
      ))}
    </div>
  );
}

function AgentCard({ agent: a }: { agent: AgentSummary }) {
  const presence = PRESENCE[a.state];
  return (
    <Link className="agcard" href="/agents">
      <div className="h">
        <Avatar initials={initials(a.name)} tone={a.tone} size="lg" />
        <span>
          <span className="nm">{a.name}</span>
          <span className="rl" style={{ display: 'block' }}>
            {a.purpose} · prompt v{a.promptVersion}
          </span>
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <Presence state={presence.state}>{presence.label}</Presence>
        </span>
      </div>
      <MetricMatrix
        columns={3}
        metrics={[
          { label: 'convs', value: formatNumber(a.conversations) },
          { label: 'contained', value: formatPercent(a.containmentRate) },
          { label: 'csat', value: formatNumber(a.csat, 2) },
        ]}
      />
      <div className="rowsplit">
        {a.slaBreaches > 0 ? (
          <StatusChip tone="danger">{a.slaBreaches} breaches</StatusChip>
        ) : a.openAlerts > 0 ? (
          <StatusChip tone="warn">{a.openAlerts} alerts</StatusChip>
        ) : (
          <StatusChip tone="muted">no alerts</StatusChip>
        )}
        <span className="mono-sm">{a.channels.join(' · ')}</span>
      </div>
    </Link>
  );
}
