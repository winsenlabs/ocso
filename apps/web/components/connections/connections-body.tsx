import { Permission } from '@ocso/auth';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { hasAnyPermission, requireSession } from '@/lib/session';
import { CONNECTION_TABS, ConnectionTabPanel, parseConnectionTab } from './connection-tab';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Tab strip (?tab=providers|mcp|channels|secrets|webhooks) and the selected panel. */
export async function ConnectionsBody({ searchParams }: { searchParams: SearchParams }) {
  const [session, params] = await Promise.all([requireSession(), searchParams]);
  if (!hasAnyPermission(session, [Permission.PROVIDERS_READ, Permission.MCP_READ, Permission.CHANNELS_READ])) {
    return <NotPermitted role={session.roleLabel} />;
  }
  const tab = parseConnectionTab(params['tab']);
  return (
    <>
      <Tabs
        label="Connection types"
        idBase="connections"
        active={tab}
        items={CONNECTION_TABS.map((t) => ({ key: t.key, label: t.label, href: `/connections?tab=${t.key}` }))}
      />
      <TabPanel idBase="connections" active={tab}>
        <ConnectionTabPanel tab={tab} />
      </TabPanel>
    </>
  );
}
