import Link from 'next/link';
import { CellTitle, DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusChip } from '@/components/ui/status-chip';
import type { Connection } from '@/lib/api/mcp';
import { formatAge } from '@/lib/format';
import { connectionsHref } from '../url';
import { authLabel, connectionStatus, scopeLabel, stepForStage } from './meta';

/** Approved connections open their details; drafts resume the wizard where they stopped. */
export function connectionHref(c: Pick<Connection, 'id' | 'approvedAt' | 'status' | 'stage'>): string {
  const settled = c.approvedAt !== null || c.status === 'DISABLED';
  return connectionsHref({ tab: 'mcp', connection: c.id, ...(settled ? {} : { step: stepForStage(c.stage) }) });
}

const TEMPLATE = 'minmax(0,1fr) minmax(0,1.3fr) 96px 92px 70px 110px 80px 60px';

/** MCP connections list (design/04 dt-conn): shared connections and user-scoped templates. */
export function ConnectionsTable({ connections, canManage }: { connections: Connection[]; canManage: boolean }) {
  return (
    <DataTable
      label="MCP connections"
      template={TEMPLATE}
      rows={connections}
      rowKey={(c) => c.id}
      empty={
        <EmptyState title="No MCP servers connected yet">
          {canManage
            ? 'Add a server: OCSO discovers its tools, you authenticate, classify each tool’s side effects and approve which agents may use them.'
            : 'A Tech admin adds MCP servers; their tools, health and approval state will appear here.'}
        </EmptyState>
      }
      columns={[
        {
          key: 'name',
          header: 'Connection',
          cell: (c) => (
            <Link className="cell-link" href={connectionHref(c)} scroll={false}>
              <CellTitle title={c.name} caption={c.description ?? undefined} />
            </Link>
          ),
        },
        { key: 'url', header: 'Server URL', cell: (c) => <span className="mono-sm">{c.url.replace(/^https?:\/\//, '')}</span> },
        { key: 'auth', header: 'Auth', cell: (c) => <span className="mono-sm">{authLabel(c.auth)}</span> },
        { key: 'scope', header: 'Scope', cell: (c) => <span className="mono-sm">{scopeLabel(c.kind)}</span> },
        {
          key: 'tools',
          header: 'Tools',
          cell: (c) => (
            <span>
              <span className="mono">{`${c.tools.approved}/${c.tools.total}`}</span>
              {c.tools.changed ? (
                <span className="mono-sm" style={{ display: 'block', color: 'var(--warn)' }}>
                  {c.tools.changed} changed
                </span>
              ) : null}
            </span>
          ),
        },
        {
          key: 'health',
          header: 'Health',
          cell: (c) => {
            const s = connectionStatus(c);
            return <StatusChip tone={s.tone}>{s.label}</StatusChip>;
          },
        },
        { key: 'sync', header: 'Last sync', cell: (c) => <span className="mono-sm">{c.lastSyncAt ? `${formatAge(c.lastSyncAt)} ago` : 'never'}</span> },
        {
          key: 'open',
          header: '',
          cell: (c) => (
            <Link className="btn tiny ghost" href={connectionHref(c)} scroll={false} aria-label={`Open ${c.name}`}>
              ⋯
            </Link>
          ),
        },
      ]}
    />
  );
}

const FLOW = [
  { h: 'Enter URL', s: 'Paste the MCP endpoint and name the connection.' },
  { h: 'Discover', s: 'OCSO reads the server’s protocol version, capabilities and tools.' },
  { h: 'Authenticate', s: 'OAuth 2.1 redirect or a header credential; OCSO keeps only a secret reference.' },
  { h: 'Review', s: 'Every tool, its side-effect class and who may run it.' },
  { h: 'Approve', s: 'Choose the agents allowed and the confirmation policy.' },
  { h: 'Active', s: 'Health checks start; approved tools reach the agents.' },
];

/** "How adding a server works" strip (design/04). */
export function FlowMap() {
  return (
    <ol className="flowmap" aria-label="How adding a server works">
      {FLOW.map((f, i) => (
        <li key={f.h} className={i === 0 ? 'on' : undefined}>
          <span className="n">{String(i + 1).padStart(2, '0')}</span>
          <span className="h">{f.h}</span>
          <span className="s">{f.s}</span>
        </li>
      ))}
    </ol>
  );
}
