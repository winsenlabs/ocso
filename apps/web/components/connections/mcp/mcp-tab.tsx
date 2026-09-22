import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { AlertBanner } from '@/components/ui/alert-banner';
import { SecHead } from '@/components/ui/sec-head';
import { getConnection, healthHistory, listAgentsLite, listConnections, listTools, type AgentLite, type Connection } from '@/lib/api/mcp';
import { getDeploymentSettings } from '@/lib/api/settings';
import { hasPermission, type Session } from '@/lib/session';
import { connectionsHref, idParam, param } from '../url';
import { ConnectionDrawer } from './connection-drawer';
import { ConnectionsTable, FlowMap } from './connections-table';
import { HealthHistory } from './health-history';
import { needsAttention, parseStep, stepForStage } from './meta';
import { McpWizard } from './wizard/mcp-wizard';

type Params = Record<string, string | string[] | undefined>;

function attentionText(c: Connection): { title: string; body: string } {
  if (c.status === 'AUTH_REQUIRED') return { title: `${c.name} needs re-authentication`, body: c.lastError ?? 'The server rejected the stored credential; its tools are unavailable.' };
  if (c.status === 'DOWN') return { title: `${c.name} is down`, body: c.lastError ?? 'Health checks fail; its tools are unavailable.' };
  if (c.status === 'DEGRADED') return { title: `${c.name} is degraded`, body: c.lastError ?? 'Health checks report degraded service.' };
  return { title: `${c.name}: ${c.tools.changed} tool${c.tools.changed === 1 ? '' : 's'} changed since approval`, body: 'Changed tools are withheld from agents until re-approved.' };
}

/** MCP connections tab: attention banners, the connections table, the add-server flow and the per-connection views. */
export async function McpTab({ session, params }: { session: Session; params: Params }) {
  const canManage = hasPermission(session, Permission.MCP_MANAGE);
  const canAgents = hasPermission(session, Permission.AGENTS_READ);
  // While the OAuth outcome banner shows, the connection opens only when the user continues.
  const openId = param(params, 'oauth') ? undefined : idParam(params, 'connection');
  const wantsNew = canManage && param(params, 'dialog') === 'mcp-new';
  const [connections, open, settings] = await Promise.all([
    listConnections(),
    openId ? getConnection(openId).catch(() => null) : Promise.resolve(null),
    getDeploymentSettings(),
  ]);
  const needsData = open !== null || wantsNew;
  const [tools, agents, samples] = await Promise.all([
    open ? listTools(open.id, { includeRemoved: true }) : Promise.resolve([]),
    needsData && canManage && canAgents ? listAgentsLite().catch((): AgentLite[] => []) : Promise.resolve([] as AgentLite[]),
    open && open.approvedAt ? healthHistory(open.id, 60) : Promise.resolve([]),
  ]);

  const closeHref = connectionsHref({ tab: 'mcp' });
  const step = parseStep(param(params, 'step'));
  const approved = open?.approvedAt != null;
  const showDrawer = open !== null && open.kind !== 'PERSONAL' && (approved || open.status === 'DISABLED') && !(canManage && step);
  const showWizard = canManage && !showDrawer && (wantsNew || (open !== null && open.kind !== 'PERSONAL'));
  const attention = connections.filter(needsAttention);
  const toolCount = connections.reduce((n, c) => n + c.tools.total, 0);

  return (
    <>
      {attention.map((c) => {
        const t = attentionText(c);
        return (
          <AlertBanner
            key={c.id}
            tone="warn"
            title={t.title}
            action={
              <Link className="btn tiny" href={connectionsHref({ tab: 'mcp', connection: c.id })} scroll={false}>
                {canManage ? 'Review' : 'Details'}
              </Link>
            }
          >
            {t.body}
          </AlertBanner>
        );
      })}
      <SecHead
        title="MCP connections"
        count={`${connections.length} server${connections.length === 1 ? '' : 's'} · ${toolCount} tools`}
        actions={
          canManage ? (
            <Link className="btn tiny accent" href={connectionsHref({ tab: 'mcp', dialog: 'mcp-new' })} scroll={false}>
              Add MCP server
            </Link>
          ) : null
        }
      />
      <ConnectionsTable connections={connections} canManage={canManage} />
      <SecHead title="How adding a server works" desc="no code, no restart — discovery and consent are the whole job" style={{ marginTop: 18 }} />
      <FlowMap />
      {canManage ? (
        <Link className="btn accent" href={connectionsHref({ tab: 'mcp', dialog: 'mcp-new' })} scroll={false}>
          Start the flow
        </Link>
      ) : null}
      {openId && !open ? (
        <AlertBanner tone="error" title="Connection not found.">
          It may have been deleted. The list above is current.
        </AlertBanner>
      ) : null}

      {showWizard ? (
        <McpWizard
          key="mcp-wizard"
          connection={open}
          tools={tools}
          agents={agents}
          initialStep={step ?? (open ? stepForStage(open.stage) : 'url')}
          closeHref={closeHref}
        />
      ) : null}
      {showDrawer && open ? (
        <ConnectionDrawer
          key={open.id}
          connection={open}
          tools={tools}
          agents={agents}
          canManage={canManage}
          closeHref={closeHref}
          health={<HealthHistory samples={samples} timezone={settings.timezone} />}
        />
      ) : null}
      {open && !showWizard && !showDrawer ? (
        <AlertBanner title={`${open.name} is not approved yet.`}>A Platform Tech Admin finishes its setup; its tools are not available until then.</AlertBanner>
      ) : null}
    </>
  );
}
