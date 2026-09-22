import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { EmptyState } from '@/components/ui/empty-state';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { getAgent, optional } from '@/lib/api/agents';
import { hasPermission, requireSession } from '@/lib/session';
import { AnalyticsTab } from '../analytics/analytics-tab';
import { ChannelsTab } from '../channels/channels-tab';
import { EscalationTab } from '../escalation/escalation-tab';
import { agentHref, isUuid, param, permittedAgentTabs, resolveAgentTab, type AgentTabKey } from '../lib/tabs';
import { OverviewTab } from '../overview/overview-tab';
import { PromptTab } from '../prompt/prompt-tab';
import { QualityTab } from '../quality/quality-tab';
import { RoutingTab } from '../routing/routing-tab';
import { SettingsTab } from '../settings/settings-tab';
import { ToolsTab } from '../tools/tools-tab';
import { VersionsTab } from '../versions/versions-tab';
import { AgentHeader } from './agent-header';
import { loadAgentPage, type AgentPageData } from './load';

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;
export type Query = Record<string, string | string[] | undefined>;

/** One virtual agent (design/02): header, tab strip (?tab=…) and the selected panel. */
export async function AgentDetail({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const [{ id }, query, session] = await Promise.all([params, searchParams, requireSession()]);
  if (!hasPermission(session, Permission.AGENTS_READ)) return <NotPermitted role={session.roleLabel} />;
  const agent = isUuid(id) ? await optional(getAgent(id)) : null;
  if (!agent) {
    return (
      <EmptyState title="Agent not found" actions={<Link className="btn" href="/agents">All virtual agents</Link>}>
        This virtual agent does not exist or was removed.
      </EmptyState>
    );
  }
  const data = await loadAgentPage(session, agent);
  const tabs = permittedAgentTabs(session.permissions);
  const tab = resolveAgentTab(param(query, 'tab'), tabs) ?? 'overview';

  return (
    <>
      <AgentHeader data={data} />
      <Tabs label="Agent sections" idBase="agent" active={tab} items={tabs.map((t) => ({ key: t.key, label: t.label, href: agentHref(agent.id, { tab: t.key }) }))} />
      <TabPanel idBase="agent" active={tab}>
        <Panel tab={tab} data={data} query={query} />
      </TabPanel>
    </>
  );
}

function Panel({ tab, data, query }: { tab: AgentTabKey; data: AgentPageData; query: Query }) {
  switch (tab) {
    case 'overview':
      return <OverviewTab data={data} />;
    case 'prompt':
      return <PromptTab data={data} />;
    case 'tools':
      return <ToolsTab data={data} />;
    case 'channels':
      return <ChannelsTab data={data} />;
    case 'routing':
      return <RoutingTab data={data} />;
    case 'escalation':
      return <EscalationTab data={data} />;
    case 'analytics':
      return <AnalyticsTab data={data} query={query} />;
    case 'versions':
      return <VersionsTab data={data} query={query} />;
    case 'quality':
      return <QualityTab data={data} />;
    case 'settings':
      return <SettingsTab data={data} />;
  }
}
