import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { CellTitle, DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHead } from '@/components/ui/page-head';
import { StatusChip, type StatusTone } from '@/components/ui/status-chip';
import { listQueues } from '@/lib/api/queues';
import { listRouters, type RouterSummary } from '@/lib/api/routers';
import { formatAge } from '@/lib/format';
import { hasPermission, requireSession } from '@/lib/session';
import { KIND_LABELS } from './lib/definition';
import { NewRouterButton } from './new-router-dialog';

const STATUS_TONE: Readonly<Record<RouterSummary['status'], StatusTone>> = { ACTIVE: 'good', DRAFT: 'muted', DISABLED: 'warn' };

const columns: Column<RouterSummary>[] = [
  {
    key: 'router',
    header: 'Router',
    cell: (r) => (
      <Link href={`/routers/${r.id}`} className="cell-link">
        <CellTitle title={r.name} caption={r.description || undefined} />
      </Link>
    ),
  },
  { key: 'status', header: 'Status', cell: (r) => <StatusChip tone={STATUS_TONE[r.status]}>{r.status.toLowerCase()}</StatusChip> },
  { key: 'kind', header: 'Kind', cell: (r) => <span className="mono-sm">{r.kind ? KIND_LABELS[r.kind] : 'not live yet'}</span> },
  { key: 'version', header: 'Live version', cell: (r) => <span className="mono">{r.activeVersion ? `v${r.activeVersion.version}` : '—'}</span> },
  { key: 'channels', header: 'Channels', cell: (r) => <span className="mono-sm">{r.channels.map((c) => c.name).join(', ') || 'none'}</span> },
  { key: 'draft', header: 'Draft edited', cell: (r) => <span className="mono-sm">{r.draftUpdatedAt ? `${formatAge(r.draftUpdatedAt)} ago` : '—'}</span> },
];

/**
 * /routers (PM/research/11 §5.7): how customers reach agents — channel →
 * router → queue → agent. Reads need routers.read; building and changing
 * routers routers.manage; going live is always a checker's approval.
 */
export async function RoutersBody() {
  const session = await requireSession();
  if (!hasPermission(session, Permission.ROUTERS_READ)) {
    return (
      <>
        <PageHead title="Routers" />
        <NotPermitted role={session.roleLabel} />
      </>
    );
  }
  const canManage = hasPermission(session, Permission.ROUTERS_MANAGE);
  const [routers, queues] = await Promise.all([listRouters(), canManage && hasPermission(session, Permission.QUEUES_READ) ? listQueues() : Promise.resolve([])]);
  return (
    <>
      <PageHead
        title="Routers"
        sub="Which queue — and so which agent — each channel’s customers reach: straight through, by a menu, or by a model, with rules over queue attributes."
        actions={canManage ? <NewRouterButton queues={queues.map((q) => ({ value: q.id, label: q.name }))} /> : null}
      />
      <DataTable
        label="Routers"
        columns={columns}
        rows={routers}
        rowKey={(r) => r.id}
        template="minmax(180px,1.4fr) 90px 110px 90px minmax(0,1.2fr) 110px"
        empty={
          <EmptyState title="No routers yet" actions={canManage ? <NewRouterButton queues={queues.map((q) => ({ value: q.id, label: q.name }))} /> : null}>
            A router decides which queue a new conversation goes to. Start with a fallback queue, add a menu question or a model classifier, then submit a version for approval.
          </EmptyState>
        }
      />
    </>
  );
}
