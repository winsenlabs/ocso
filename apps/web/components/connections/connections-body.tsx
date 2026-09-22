import { Permission } from '@ocso/auth';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { hasPermission, requireSession } from '@/lib/session';
import { ChannelsTab } from './channels/channels-tab';
import { permittedTabs, resolveTab, type ConnectionTab } from './connection-tab';
import { McpTab } from './mcp/mcp-tab';
import { OAuthReturnBanner, oauthReturnOf } from './mcp/oauth-return';
import { PersonalTab } from './personal/personal-tab';
import { ProvidersTab } from './providers/providers-tab';
import { SecretsTab } from './secrets/secrets-tab';
import { connectionsHref, param } from './url';
import { WebhooksTab } from './webhooks/webhooks-tab';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Tab strip (?tab=providers|mcp|channels|secrets|webhooks|mine) and the
 * selected panel. Tabs follow the user's permissions; the API enforces them.
 */
export async function ConnectionsBody({ searchParams }: { searchParams: SearchParams }) {
  const [session, params] = await Promise.all([requireSession(), searchParams]);
  const tabs = permittedTabs(session);
  const requested = resolveTab(param(params, 'tab'), tabs);
  if (!requested) return <NotPermitted role={session.roleLabel} />;

  // The OAuth callback always returns to ?tab=mcp; a personal connection belongs on "My connections".
  const oauth = await oauthReturnOf(params, { canReadShared: hasPermission(session, Permission.MCP_READ) });
  const tab: ConnectionTab = oauth?.personal && tabs.some((t) => t.key === 'mine') ? 'mine' : requested;

  return (
    <>
      {oauth ? <OAuthReturnBanner result={oauth} /> : null}
      <Tabs
        label="Connection types"
        idBase="connections"
        active={tab}
        items={tabs.map((t) => ({ key: t.key, label: t.label, href: connectionsHref({ tab: t.key }) }))}
      />
      <TabPanel idBase="connections" active={tab}>
        {tab === 'providers' ? <ProvidersTab session={session} params={params} /> : null}
        {tab === 'mcp' ? <McpTab session={session} params={params} /> : null}
        {tab === 'channels' ? <ChannelsTab session={session} /> : null}
        {tab === 'secrets' ? <SecretsTab session={session} /> : null}
        {tab === 'webhooks' ? <WebhooksTab session={session} params={params} /> : null}
        {tab === 'mine' ? <PersonalTab params={params} /> : null}
      </TabPanel>
    </>
  );
}
