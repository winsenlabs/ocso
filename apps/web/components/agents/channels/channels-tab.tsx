import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { ChannelMark } from '@/components/ui/channel-mark';
import { EmptyState } from '@/components/ui/empty-state';
import { SecHead } from '@/components/ui/sec-head';
import { StatusChip, type StatusTone } from '@/components/ui/status-chip';
import { channelMark } from '@/components/workspace/lib/channel';
import { loadChannelKinds } from '@/lib/api/channels';
import { getAgentAnalytics, optional } from '@/lib/api/agents';
import { loadAgentReach } from '@/lib/api/routers';
import { formatNumber, formatPercent } from '@/lib/format';
import { hasPermission, requireSession } from '@/lib/session';
import type { AgentPageData } from '../detail/load';
import { Definitions } from '../shared/definition';

const STATUS_TONE: Readonly<Record<string, StatusTone>> = { ACTIVE: 'good', DRAFT: 'muted', DISABLED: 'warn' };
const TEMPLATE = 'minmax(0,1.2fr) 84px minmax(0,1fr) minmax(0,1fr) 84px 96px 70px';

/**
 * Channels tab (design/02; PM/research/11 §5.7): "Reached through" — the
 * channels whose active router can send customers to a queue this agent
 * serves (channel → router → queue → agent). Derived, never edited here:
 * change the router or the queue instead. 7-day volume, containment and CSAT
 * per channel for roles that read business analytics.
 */
export async function ChannelsTab({ data }: { data: AgentPageData }) {
  const { agent, can } = data;
  const session = await requireSession();
  if (!hasPermission(session, Permission.ROUTERS_READ)) {
    return <EmptyState title="Channels are not available for your role">A Lead can see which channels reach this agent through routers.</EmptyState>;
  }
  const [reach, analytics, kinds] = await Promise.all([optional(loadAgentReach(agent.id)), can.analytics ? optional(getAgentAnalytics(agent.id, 7)) : Promise.resolve(null), loadChannelKinds()]);
  const byChannel = new Map((analytics?.channels.items ?? []).map((c) => [c.channelId, c]));
  const rows = reach ?? [];
  const channels = new Set(rows.map((r) => r.channel.id));
  return (
    <>
      <SecHead title="Reached through" count={`${channels.size} channel${channels.size === 1 ? '' : 's'}`} desc="channel → router → queue → this agent · set by routers and queues · metrics: last 7 days" />
      {rows.length === 0 ? (
        <EmptyState
          title="No channel reaches this agent yet"
          actions={
            <Link className="btn tiny" href="/routers">
              Open routers
            </Link>
          }
        >
          Give a queue this agent (Queues), then route a channel to that queue with a router. Customers reach the agent once the router’s version is approved.
        </EmptyState>
      ) : (
        <div className="dtable" role="table" aria-label="Reached through">
          <div className="dt-head" role="row" style={{ gridTemplateColumns: TEMPLATE }}>
            {['Channel', 'Status', 'Router', 'Queue', 'Volume', 'Containment', 'CSAT'].map((h) => (
              <span key={h} role="columnheader">
                {h}
              </span>
            ))}
          </div>
          {rows.map((r) => {
            const m = byChannel.get(r.channel.id);
            const mark = channelMark(kinds, r.channel.kind);
            return (
              <div className="dt-row" role="row" key={`${r.channel.id}:${r.queue.id}`} style={{ gridTemplateColumns: TEMPLATE }}>
                <span role="cell" style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  {mark ? <ChannelMark mark={mark} /> : null}
                  <span style={{ minWidth: 0 }}>
                    {r.channel.name}
                    <span className="mono-sm row-note">{r.channel.kind.toLowerCase()}</span>
                  </span>
                </span>
                <span role="cell">
                  <StatusChip tone={STATUS_TONE[r.channel.status] ?? 'muted'}>{r.channel.status.toLowerCase()}</StatusChip>
                </span>
                <span role="cell">
                  <Link href={`/routers/${r.router.id}`}>{r.router.name}</Link>
                </span>
                <span role="cell" className="mono-sm">
                  {r.queue.name}
                </span>
                <span role="cell" className="mono">
                  {analytics ? formatNumber(m?.conversations ?? 0) : '—'}
                </span>
                <span role="cell" className="mono">
                  {formatPercent(m?.containmentRate ?? null)}
                </span>
                <span role="cell" className="mono">
                  {m?.csat !== null && m?.csat !== undefined ? formatNumber(m.csat, 2) : '—'}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {analytics ? (
        <Definitions
          items={[
            { label: 'volume', definition: analytics.tiles.conversations.definition },
            { label: 'containment · csat', definition: analytics.channels.definition },
          ]}
        />
      ) : null}
    </>
  );
}
