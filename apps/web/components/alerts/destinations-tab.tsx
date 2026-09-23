import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { SecHead } from '@/components/ui/sec-head';
import { StatusChip } from '@/components/ui/status-chip';
import { listDestinationKinds, listDestinations } from '@/lib/api/alerts';
import { hasPermission, type Session } from '@/lib/session';
import { alertsHref, type AlertsParams } from './alerts-meta';
import { LifecycleActions } from '@/components/connections/lifecycle-actions';
import { DestinationDialog } from './destination-dialog';
import { receivesText } from './destination-form';
import { TestDestinationButton } from './test-destination-button';

/** Notification destinations (docs/11 §7): pluggable delivery targets, managed by the Tech admin. */
export async function DestinationsTab({ session, params }: { session: Session; params: AlertsParams }) {
  if (!hasPermission(session, Permission.NOTIFICATION_DESTINATIONS_MANAGE)) return <NotPermitted role={session.roleLabel} />;
  const [destinations, kinds] = await Promise.all([listDestinations(), listDestinationKinds()]);
  // A destination whose adapter is no longer registered still lists, by its raw kind.
  const kindOf = new Map(kinds.map((k) => [k.kind, k]));
  const editing = params.destination && params.destination !== 'new' ? destinations.find((d) => d.id === params.destination) : undefined;
  const closeHref = alertsHref({ tab: 'destinations' });

  return (
    <>
      <SecHead
        title="Notification destinations"
        count={destinations.length}
        desc="rules deliver alerts here; secrets are write-only"
        actions={
          <Link className="btn tiny" href={alertsHref({ tab: 'destinations', destination: 'new' })} scroll={false}>
            Add destination
          </Link>
        }
      />
      <DataTable
        label="Notification destinations"
        template="minmax(0,1.1fr) 130px minmax(0,1.2fr) 84px 80px minmax(170px,1fr) minmax(150px,0.9fr)"
        rows={destinations}
        rowKey={(d) => d.id}
        empty={<EmptyState title="No destination yet">Add {kinds.map((k) => k.label).join(', ') || 'a'} delivery for alert rules.</EmptyState>}
        columns={[
          {
            key: 'name',
            header: 'Destination',
            cell: (d) => (
              <Link className="cell-btn" href={alertsHref({ tab: 'destinations', destination: d.id })} scroll={false}>
                <b style={{ fontSize: 12.5 }}>{d.name}</b>
                <span className="mono-sm" style={{ display: 'block' }}>
                  receives {receivesText(kindOf.get(d.kind)?.events ?? [])}
                </span>
              </Link>
            ),
          },
          { key: 'kind', header: 'Type', cell: (d) => <span className="mono-sm">{kindOf.get(d.kind)?.label ?? d.kind}</span> },
          { key: 'config', header: 'Configuration', cell: (d) => <span className="mono-sm">{d.summary ?? '—'}</span> },
          {
            key: 'secret',
            header: 'Secret',
            cell: (d) => <span className="mono-sm">{kindOf.get(d.kind)?.secret ? (d.hasSecret ? 'stored' : 'none') : 'n/a'}</span>,
          },
          { key: 'on', header: 'State', cell: (d) => <StatusChip tone={d.enabled ? 'good' : 'muted'}>{d.enabled ? 'enabled' : d.approval?.approved ? 'disabled' : 'draft'}</StatusChip> },
          {
            // Enabling (and re-enabling) is a second person's approval; disabling is immediate.
            key: 'approval',
            header: 'Approval',
            cell: (d) => (
              <LifecycleActions kind="notification_destination" id={d.id} name={d.name} state={d.enabled ? 'live' : d.approval?.approved ? 'stopped' : 'draft'} approval={d.approval} activateLabel={d.approval?.approved ? 'Re-enable' : 'Enable'} canDelete={false} />
            ),
          },
          { key: 'test', header: 'Test', cell: (d) => <TestDestinationButton id={d.id} name={d.name} /> },
        ]}
      />
      {params.destination === 'new' || editing ? <DestinationDialog key={editing?.id ?? 'new'} destination={editing ?? null} kinds={kinds} closeHref={closeHref} /> : null}
    </>
  );
}
