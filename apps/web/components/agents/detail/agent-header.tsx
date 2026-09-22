import Link from 'next/link';
import type { ReactNode } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Presence } from '@/components/ui/presence';
import { StatusChip } from '@/components/ui/status-chip';
import { initials } from '@/lib/format';
import { optionName } from '../data/options';
import { CONVERSATION_TYPE_LABELS, agentPresence, formatDay } from '../lib/labels';
import { agentHref } from '../lib/tabs';
import type { AgentPageData } from './load';
import { AgentStatusButton } from './status-button';

const TONES = new Set(['indigo', 'violet', 'rose', 'amber', 'emerald', 'sky', 'teal']);

/** Agent header (design/02 .ahead): identity, facts, lifecycle actions and open alerts. */
export function AgentHeader({ data }: { data: AgentPageData }) {
  const { agent, live, options, tools, alerts, can, timeZone } = data;
  const presence = agentPresence(agent.status);
  const tone = TONES.has(agent.avatarTone) ? agent.avatarTone : 'indigo';
  const enabledTools = tools?.filter((t) => t.grant?.enabled) ?? null;
  const openAlerts = alerts?.filter((a) => a.status !== 'RESOLVED') ?? [];

  return (
    <div className="ahead">
      <span className="agent-portrait" style={{ background: `var(--tone-${tone})` }} aria-hidden="true">
        {initials(agent.name)}
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="rowsplit" style={{ flexWrap: 'wrap' }}>
          <h1>{agent.name}{agent.purpose ? ` — ${agent.purpose}` : ''}</h1>
          <Presence state={presence.state}>{presence.label}</Presence>
          <StatusChip tone="muted">{(CONVERSATION_TYPE_LABELS[agent.conversationType] ?? agent.conversationType).toUpperCase()}</StatusChip>
          <span className="mono-sm">
            {agent.slug} · created {formatDay(agent.createdAt, timeZone, true)}
          </span>
        </div>
        {agent.description ? <p className="desc">{agent.description}</p> : null}
        <div className="facts">
          <Fact k="channels" v={channelsFact(data)} />
          <Fact
            k="model profile"
            v={
              agent.modelProfileId ? (
                can.providers ? (
                  <Link href="/connections?tab=providers">{optionName(options.profiles, agent.modelProfileId) ?? 'assigned'}</Link>
                ) : (
                  (optionName(options.profiles, agent.modelProfileId) ?? 'assigned')
                )
              ) : (
                'not assigned'
              )
            }
          />
          <Fact k="prompt version" v={live ? `v${live.version}${live.firstActivatedAt ? ` · live ${formatDay(live.firstActivatedAt, timeZone)}` : ''}` : 'none active'} />
          <Fact k="queue" v={agent.defaultQueueId ? (optionName(options.queues, agent.defaultQueueId) ?? 'assigned') : 'none'} />
          <Fact k="business hours" v={hoursFact(agent.businessHours)} />
          <Fact
            k="tools"
            v={enabledTools ? `${enabledTools.length} enabled · ${new Set(enabledTools.map((t) => t.connectionId)).size} connections` : '—'}
          />
        </div>
      </div>
      <div className="side">
        {can.manage || can.editPrompt ? (
          <div style={{ display: 'flex', gap: 6 }}>
            {can.manage ? <AgentStatusButton agentId={agent.id} name={agent.name} status={agent.status} /> : null}
            {can.editPrompt ? (
              <Link className="btn tiny accent" href={agentHref(agent.id, { tab: 'prompt' })}>
                Create new version
              </Link>
            ) : null}
          </div>
        ) : null}
        <span className="mono-sm">changes are versioned and attributable</span>
        {openAlerts.length ? (
          <AlertBanner tone={openAlerts.some((a) => a.severity === 'CRITICAL') ? 'error' : 'warn'} title={`${openAlerts.length} open alert${openAlerts.length === 1 ? '' : 's'}`}>
            {openAlerts
              .slice(0, 2)
              .map((a) => a.title)
              .join(' · ')}
          </AlertBanner>
        ) : null}
      </div>
    </div>
  );
}

function Fact({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div>
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  );
}

function channelsFact({ agent, options }: AgentPageData): string {
  if (agent.channelIds.length === 0) return 'none assigned';
  if (!options.channels) return `${agent.channelIds.length} assigned`;
  const names = agent.channelIds.map((id) => optionName(options.channels, id)).filter((n): n is string => !!n);
  return names.length ? names.join(' · ') : `${agent.channelIds.length} assigned`;
}

/** AI answers around the clock; humanHours limits when handoffs reach people (empty = 24×7). */
function hoursFact(hours: { timezone: string; humanHours: Record<string, [string, string]> }): string {
  const days = Object.entries(hours.humanHours);
  if (days.length === 0) return 'AI 24×7 · humans 24×7';
  const spans = new Set(days.map(([, [from, to]]) => `${from}–${to}`));
  const span = spans.size === 1 ? [...spans][0] : 'varies by day';
  return `AI 24×7 · humans ${span} (${days.length} days, ${hours.timezone})`;
}
