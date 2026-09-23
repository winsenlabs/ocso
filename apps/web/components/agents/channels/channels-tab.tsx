import { EmptyState } from '@/components/ui/empty-state';
import { SecHead } from '@/components/ui/sec-head';
import { channelMark } from '@/components/workspace/lib/channel';
import { loadChannelKinds } from '@/lib/api/channels';
import { getAgentAnalytics, listAgents, optional } from '@/lib/api/agents';
import { formatNumber, formatPercent } from '@/lib/format';
import type { AgentPageData } from '../detail/load';
import { Definitions } from '../shared/definition';
import { ChannelAssignment, type ChannelRow } from './channel-assignment';

/**
 * Channels tab (design/02): where this agent answers, with 7-day volume,
 * containment and CSAT per channel for roles that read business analytics.
 * The mockup's per-channel media column is omitted: the agent's multimodal
 * settings (Settings tab) apply to every channel.
 */
export async function ChannelsTab({ data }: { data: AgentPageData }) {
  const { agent, options, can } = data;
  const channels = options.channelRows;
  if (!channels) return <EmptyState title="Channels are not available for your role">A Lead or Tech admin can see which channels this agent answers on.</EmptyState>;
  const [analytics, agents, kinds] = await Promise.all([can.analytics ? optional(getAgentAnalytics(agent.id, 7)) : Promise.resolve(null), optional(listAgents()), loadChannelKinds()]);
  const names = new Map((agents ?? []).map((a) => [a.id, a.name]));
  const byChannel = new Map((analytics?.channels.items ?? []).map((c) => [c.channelId, c]));
  const rows: ChannelRow[] = channels.map((c) => {
    const m = byChannel.get(c.id);
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      mark: channelMark(kinds, c.kind),
      status: c.status,
      defaultAgent: c.defaultAgentId === agent.id ? 'this' : c.defaultAgentId ? 'other' : 'none',
      defaultAgentName: c.defaultAgentId ? (names.get(c.defaultAgentId) ?? null) : null,
      volume: analytics ? formatNumber(m?.conversations ?? 0) : '—',
      containment: formatPercent(m?.containmentRate ?? null),
      csat: m?.csat !== null && m?.csat !== undefined ? `${formatNumber(m.csat, 2)}` : '—',
    };
  });
  return (
    <>
      <SecHead title="Channels" count={`${agent.channelIds.length} assigned`} desc="what customers reach this agent on · a channel answers as one agent · metrics: last 7 days" />
      {rows.length === 0 ? (
        <EmptyState title="No channels configured">A Tech admin adds channels (web chat, WhatsApp…) under Connections; assign them to this agent here.</EmptyState>
      ) : (
        <ChannelAssignment key={agent.channelIds.join()} agentId={agent.id} rows={rows} assigned={agent.channelIds} canEdit={can.manage} />
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
