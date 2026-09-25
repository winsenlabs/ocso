import Link from 'next/link';
import { CellTitle, DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { SecHead } from '@/components/ui/sec-head';
import { StatusChip } from '@/components/ui/status-chip';
import { listMyConnections, listTemplates, listTools } from '@/lib/api/mcp';
import { formatAge } from '@/lib/format';
import { authLabel, connectionStatus } from '../mcp/meta';
import { connectionsHref, idParam, param } from '../url';
import { ConnectTemplateButton } from './connect-template-button';
import { PersonalConnectionPanel } from './personal-connection-panel';

type Params = Record<string, string | string[] | undefined>;

/**
 * "My connections" (docs/08 §3 user connections): the signed-in user's own
 * accounts on MCP servers an admin published as user-scoped templates. Only
 * this user can operate them; virtual agents never use them.
 */
export async function PersonalTab({ params }: { params: Params }) {
  const openId = param(params, 'oauth') ? undefined : idParam(params, 'connection');
  const [templates, mine] = await Promise.all([listTemplates(), listMyConnections()]);
  const open = openId ? mine.find((c) => c.id === openId) : undefined;
  const tools = open ? await listTools(open.id, { area: 'personal' }) : [];
  const connected = new Set(mine.map((c) => c.templateId));
  const available = templates.filter((t) => !connected.has(t.id));

  return (
    <>
      <SecHead title="My connections" count={mine.length} desc="your own accounts · only you can use them, never a virtual agent" />
      <DataTable
        label="My connections"
        template="minmax(0,1fr) minmax(0,1.2fr) 110px 80px 110px 70px"
        rows={mine}
        rowKey={(c) => c.id}
        empty={<EmptyState title="You have not connected an account yet">Connect one of the servers below; OCSO stores your credential by reference and uses it only for actions you take.</EmptyState>}
        columns={[
          {
            key: 'name',
            header: 'Connection',
            cell: (c) => (
              <Link className="cell-link" href={connectionsHref({ tab: 'mcp', view: 'mine', connection: c.id })} scroll={false}>
                <CellTitle title={c.name} caption={c.description ?? undefined} />
              </Link>
            ),
          },
          { key: 'url', header: 'Server', cell: (c) => <span className="mono-sm">{c.url.replace(/^https?:\/\//, '')}</span> },
          { key: 'auth', header: 'Auth', cell: (c) => <span className="mono-sm">{authLabel(c.auth)}</span> },
          { key: 'tools', header: 'Tools', cell: (c) => <span className="mono">{`${c.tools.approved}/${c.tools.total}`}</span> },
          {
            key: 'status',
            header: 'Status',
            cell: (c) => {
              const s = connectionStatus(c);
              return <StatusChip tone={s.tone}>{s.label}</StatusChip>;
            },
          },
          { key: 'sync', header: 'Synced', cell: (c) => <span className="mono-sm">{c.lastSyncAt ? `${formatAge(c.lastSyncAt)} ago` : 'never'}</span> },
        ]}
      />
      <SecHead title="Available to connect" count={available.length} desc="published by a Tech admin" style={{ marginTop: 18 }} />
      {available.length ? (
        <div className="g g3 conn-grid" role="list" aria-label="Available servers">
          {available.map((t) => (
            <div role="listitem" key={t.id} aria-label={t.name} className="pvd">
              <div className="h">
                <span className="logo" aria-hidden="true">
                  MCP
                </span>
                <span className="nm">{t.name}</span>
              </div>
              {t.description ? <span style={{ fontSize: 12 }}>{t.description}</span> : null}
              <span className="mono-sm">{`${t.url.replace(/^https?:\/\//, '')} · ${t.tools.approved} approved tools`}</span>
              <div className="rowsplit">
                <ConnectTemplateButton templateId={t.id} name={t.name} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title={templates.length ? 'You are connected to every published server' : 'Nothing published for personal use yet'}>
          {templates.length ? 'Servers an admin publishes later will appear here.' : 'A Tech admin publishes user-scoped MCP servers (for example your ticketing or calendar account); they will appear here.'}
        </EmptyState>
      )}
      {open ? <PersonalConnectionPanel key={open.id} connection={open} tools={tools} closeHref={connectionsHref({ tab: 'mcp', view: 'mine' })} /> : null}
    </>
  );
}
