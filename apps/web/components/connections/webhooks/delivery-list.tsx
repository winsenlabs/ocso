import Link from 'next/link';
import { DataTable } from '@/components/ui/data-table';
import { StatusChip } from '@/components/ui/status-chip';
import type { Delivery } from '@/lib/api/webhooks';
import { formatDateTime } from '@/lib/format';
import { connectionsHref } from '../url';
import { RetryDeliveryButton } from './retry-delivery-button';

const FILTERS = [
  { key: undefined, label: 'All' },
  { key: 'FAILED', label: 'Failed' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'SENT', label: 'Sent' },
] as const;
const TONE = { SENT: 'good', PENDING: 'warn', FAILED: 'danger' } as const;

/** Recent deliveries of one subscription (latest 100), filterable by status; failed ones can be retried. */
export function DeliveryList({ webhookId, deliveries, status, timezone }: { webhookId: string; deliveries: Delivery[]; status: Delivery['status'] | undefined; timezone: string }) {
  return (
    <section aria-label="Recent deliveries" style={{ display: 'grid', gap: 8 }}>
      <div className="rowsplit">
        <b style={{ fontSize: 12.5 }}>Recent deliveries</b>
        <span className="sp" />
        <div role="group" aria-label="Delivery status" style={{ display: 'flex', gap: 5 }}>
          {FILTERS.map((f) => (
            <Link
              key={f.label}
              className={f.key === status ? 'fchip active' : 'fchip'}
              aria-current={f.key === status ? 'true' : undefined}
              href={connectionsHref({ tab: 'webhooks', dialog: 'webhook-edit', id: webhookId, deliveries: f.key })}
              scroll={false}
              replace
            >
              {f.label}
            </Link>
          ))}
        </div>
      </div>
      <DataTable
        label="Recent deliveries"
        template="minmax(0,1.2fr) 80px 60px minmax(0,1fr) 70px"
        rows={deliveries}
        rowKey={(d) => d.id}
        empty={<span className="mono-sm">{status ? `No ${status.toLowerCase()} deliveries.` : 'No deliveries yet. Send a test to check the receiver.'}</span>}
        columns={[
          {
            key: 'event',
            header: 'Event',
            cell: (d) => (
              <span>
                <span className="mono-sm" style={{ color: 'var(--ink)' }}>
                  {d.eventType}
                </span>
                <span className="mono-sm" style={{ display: 'block' }}>
                  {formatDateTime(d.createdAt, timezone)}
                </span>
              </span>
            ),
          },
          { key: 'status', header: 'Status', cell: (d) => <StatusChip tone={TONE[d.status]}>{d.status.toLowerCase()}</StatusChip> },
          { key: 'tries', header: 'Tries', cell: (d) => <span className="mono">{d.attempts}</span> },
          { key: 'resp', header: 'Response', cell: (d) => <span className="mono-sm">{d.lastError ?? (d.responseStatus ? `HTTP ${d.responseStatus}` : '—')}</span> },
          { key: 'retry', header: '', cell: (d) => (d.status === 'FAILED' ? <RetryDeliveryButton deliveryId={d.id} /> : null) },
        ]}
      />
    </section>
  );
}
