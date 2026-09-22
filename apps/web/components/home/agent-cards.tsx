import Link from 'next/link';
import { Avatar, type AvatarTone } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/empty-state';
import { MetricMatrix } from '@/components/ui/metric-matrix';
import { Presence, type PresenceState } from '@/components/ui/presence';
import { StatusChip } from '@/components/ui/status-chip';
import type { HomeAgentCard } from '@/lib/api/home';
import { formatNumber, formatPercent, initials } from '@/lib/format';

const TONES: readonly AvatarTone[] = ['indigo', 'sky', 'amber', 'violet', 'emerald', 'rose', 'teal'];

/** Stable avatar tone per agent id (no meaning beyond telling agents apart). */
function toneOf(id: string): AvatarTone {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length] ?? 'indigo';
}

function presence(a: HomeAgentCard): { state: PresenceState; label: string } {
  if (a.status === 'PAUSED') return { state: 'paused', label: 'paused' };
  if (a.status === 'DRAFT') return { state: 'onboarding', label: 'draft' };
  if (a.slaBreaches > 0) return { state: 'blocked', label: 'sla risk' };
  return { state: 'working', label: 'live' };
}

/** Virtual agent cards (design/06 .agcard), last 7 days. */
export function AgentCards({ agents }: { agents: HomeAgentCard[] }) {
  if (agents.length === 0) {
    return (
      <div style={{ marginBottom: 18 }}>
        <EmptyState title="No virtual agents yet">Each agent&apos;s conversations, AI containment, CSAT and open alerts appear here once it exists.</EmptyState>
      </div>
    );
  }
  return (
    <div className="g g3" style={{ marginBottom: 18 }} role="list" aria-label="Virtual agents">
      {agents.map((a) => {
        const p = presence(a);
        return (
          <Link className="agcard" href="/agents" key={a.agentId} role="listitem" aria-label={a.name}>
            <div className="h">
              <Avatar initials={initials(a.name)} tone={toneOf(a.agentId)} size="lg" />
              <span>
                <span className="nm">{a.name}</span>
                <span className="rl" style={{ display: 'block' }}>
                  {a.conversationType.toLowerCase()}
                  {a.promptVersion !== null ? ` · prompt v${a.promptVersion}` : ' · no active prompt'}
                </span>
              </span>
              <span style={{ marginLeft: 'auto' }}>
                <Presence state={p.state}>{p.label}</Presence>
              </span>
            </div>
            <MetricMatrix
              columns={3}
              metrics={[
                { label: 'convs', value: formatNumber(a.conversations) },
                { label: 'contained', value: formatPercent(a.containmentRate) },
                { label: 'csat', value: a.csat === null ? '—' : formatNumber(a.csat, 2) },
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
              <span className="mono-sm">{a.channels.length ? a.channels.map((c) => c.name).join(' · ') : 'no channel'}</span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
