import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { Avatar, type AvatarTone } from '@/components/ui/avatar';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHead } from '@/components/ui/page-head';
import { Presence } from '@/components/ui/presence';
import { StatusChip } from '@/components/ui/status-chip';
import { getAgentComparison, listAgents, optional } from '@/lib/api/agents';
import { formatNumber, formatPercent, initials } from '@/lib/format';
import { hasPermission, requireSession } from '@/lib/session';
import type { Agent } from '../data/agent-schemas';
import { loadAgentOptions, optionName, type Option } from '../data/options';
import { CONVERSATION_TYPE_LABELS, agentPresence } from '../lib/labels';
import { Def, Definitions } from '../shared/definition';
import { NewAgentButton } from './new-agent-dialog';

export const PAGE_TITLE = 'Virtual agents';
export const PAGE_SUB = 'Named AI employees: their prompts, tools, channels and performance. Agents are logical — any worker can run any of them.';

const TONES: readonly AvatarTone[] = ['indigo', 'violet', 'rose', 'amber', 'emerald', 'sky', 'teal'];
const tone = (t: string): AvatarTone => (TONES as readonly string[]).includes(t) ? (t as AvatarTone) : 'indigo';

/** Page head with "New agent" for roles that can create agents. */
export async function AgentsHead() {
  const session = await requireSession();
  if (!hasPermission(session, Permission.AGENTS_MANAGE)) return <PageHead title={PAGE_TITLE} sub={PAGE_SUB} />;
  const options = await loadAgentOptions(session);
  return <PageHead title={PAGE_TITLE} sub={PAGE_SUB} actions={<NewAgentButton profiles={options.profiles} queues={options.queues} channels={options.channels} />} />;
}

export async function AgentsList() {
  const session = await requireSession();
  if (!hasPermission(session, Permission.AGENTS_READ)) return <NotPermitted role={session.roleLabel} />;
  const analytics = hasPermission(session, Permission.ANALYTICS_BUSINESS_READ);
  const [agents, options, comparison] = await Promise.all([
    listAgents(),
    loadAgentOptions(session),
    analytics ? optional(getAgentComparison(7)) : Promise.resolve(null),
  ]);
  if (agents.length === 0) {
    return (
      <EmptyState title="No virtual agents yet">
        {hasPermission(session, Permission.AGENTS_MANAGE)
          ? 'Create a virtual agent, give it a model profile and a channel, then take it live.'
          : 'A CS Lead creates virtual agents. They will appear here with their prompt, tools and 7-day performance.'}
      </EmptyState>
    );
  }
  const defs = comparison?.definitions ?? {};
  return (
    <>
      <DataTable
        label="Virtual agents"
        rows={agents}
        rowKey={(a) => a.id}
        template="minmax(0,1.6fr) 92px 96px minmax(0,1fr) 88px 96px 92px 76px 80px"
        columns={columns(options.profiles, defs)}
      />
      <p className="mono-sm" style={{ marginTop: 10 }}>
        last 7 days · conversations opened in the window · waiting = conversations waiting for a human now
      </p>
      <Definitions
        items={[
          { label: 'containment', definition: defs['containmentRate'] ?? '' },
          { label: 'escalation', definition: defs['escalationRate'] ?? '' },
          { label: 'csat', definition: defs['csat'] ?? '' },
        ]}
      />
    </>
  );
}

function columns(profiles: Option[] | null, defs: Record<string, string>): Column<Agent>[] {
  return [
    {
      key: 'agent',
      header: 'Agent',
      cell: (a) => (
        <Link className="agent-list-name" href={`/agents/${a.id}`}>
          <Avatar initials={initials(a.name)} tone={tone(a.avatarTone)} />
          <span style={{ minWidth: 0 }}>
            <b style={{ fontSize: 12.5 }}>{a.name}</b>
            <span className="mono-sm" style={{ display: 'block' }}>
              {a.purpose || a.slug}
            </span>
          </span>
        </Link>
      ),
    },
    { key: 'status', header: 'Status', cell: (a) => <Presence state={agentPresence(a.status).state}>{agentPresence(a.status).label}</Presence> },
    { key: 'type', header: 'Type', cell: (a) => <StatusChip tone="muted">{CONVERSATION_TYPE_LABELS[a.conversationType] ?? a.conversationType}</StatusChip> },
    {
      key: 'profile',
      header: 'Model profile',
      cell: (a) => <span className="mono-sm">{a.modelProfileId ? (optionName(profiles, a.modelProfileId) ?? 'assigned') : 'not assigned'}</span>,
    },
    { key: 'convs', header: 'Convs 7d', cell: (a) => <span className="mono">{formatNumber(a.stats?.conversations ?? null)}</span> },
    { key: 'containment', header: <Def definition={defs['containmentRate']}>Containment</Def>, cell: (a) => <span className="mono">{formatPercent(a.stats?.containmentRate)}</span> },
    { key: 'escalation', header: <Def definition={defs['escalationRate']}>Escalation</Def>, cell: (a) => <span className="mono">{formatPercent(a.stats?.escalationRate)}</span> },
    {
      key: 'csat',
      header: <Def definition={defs['csat']}>CSAT</Def>,
      cell: (a) => <span className="mono" title={a.stats ? `${a.stats.csatResponses} responses` : undefined}>{formatNumber(a.stats?.csat ?? null, 2)}</span>,
    },
    { key: 'waiting', header: 'Waiting', cell: (a) => <span className="mono">{formatNumber(a.stats?.waitingForHuman ?? null)}</span> },
  ];
}
