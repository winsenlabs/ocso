import { Permission } from '@ocso/auth';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { hasPermission, requireSession } from '@/lib/session';
import { ChannelsTab } from './channels/channels-tab';
import { permittedTabs, permittedViews, resolveTab, resolveView, type McpView } from './connection-tab';
import { McpTab } from './mcp/mcp-tab';
import { OAuthReturnBanner, oauthReturnOf } from './mcp/oauth-return';
import { PersonalTab } from './personal/personal-tab';
import { ProvidersTab } from './providers/providers-tab';
import { SecretsTab } from './secrets/secrets-tab';
import { connectionsHref, param } from './url';
import { WebhooksTab } from './webhooks/webhooks-tab';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * The Integrations section in `?tab=providers|mcp|channels|secrets|webhooks`.
 * Sections are sidebar destinations, so there is no tab strip across them;
 * MCP connections has two views (`&view=shared|mine`). Sections follow the
 * user's permissions; the API enforces them.
 */
export async function ConnectionsBody({ searchParams }: { searchParams: SearchParams }) {
  const [session, params] = await Promise.all([requireSession(), searchParams]);
  const tab = resolveTab(param(params, 'tab'), permittedTabs(session));
  if (!tab) return <NotPermitted role={session.roleLabel} />;

  if (tab === 'providers') return <ProvidersTab session={session} params={params} />;
  if (tab === 'channels') return <ChannelsTab session={session} params={params} />;
  if (tab === 'secrets') return <SecretsTab session={session} />;
  if (tab === 'webhooks') return <WebhooksTab session={session} params={params} />;
  return <McpSection params={params} />;
}

async function McpSection({ params }: { params: Record<string, string | string[] | undefined> }) {
  const session = await requireSession();
  const views = permittedViews(session);
  // The OAuth callback always returns to ?tab=mcp; a personal connection belongs on "My connections".
  const oauth = await oauthReturnOf(params, { canReadShared: hasPermission(session, Permission.MCP_READ) });
  const requested = resolveView(param(params, 'view'), views);
  const view: McpView | null = oauth?.personal && views.some((v) => v.key === 'mine') ? 'mine' : requested;
  if (!view) return <NotPermitted role={session.roleLabel} />;

  const panel = view === 'shared' ? <McpTab session={session} params={params} /> : <PersonalTab params={params} />;
  return (
    <>
      {oauth ? <OAuthReturnBanner result={oauth} /> : null}
      {views.length > 1 ? (
        <>
          <Tabs
            label="MCP connection views"
            idBase="mcp-views"
            active={view}
            items={views.map((v) => ({ key: v.key, label: v.label, href: connectionsHref({ tab: 'mcp', view: v.key === 'shared' ? undefined : v.key }) }))}
          />
          <TabPanel idBase="mcp-views" active={view}>
            {panel}
          </TabPanel>
        </>
      ) : (
        panel
      )}
    </>
  );
}
