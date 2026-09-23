import Form from 'next/form';
import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { hrefWith, idParam, param, type SearchParams } from '@/components/analytics/params';
import { humanizeCode } from '@/components/analytics/metrics';
import { RoutedDrawer } from '@/components/quality/routed-drawer';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { CellTitle, DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { SecHead } from '@/components/ui/sec-head';
import { searchCustomers, type CustomerListItem } from '@/lib/api/customers';
import { formatDateTime } from '@/lib/format';
import { hasPermission, requireSession } from '@/lib/session';
import { CustomerDetailView, loadCustomerPanel } from './customer-detail';

export const customerName = (c: { displayName: string | null }) => c.displayName ?? 'Unnamed customer';

function columns(q: string | undefined, zone: string): Column<CustomerListItem>[] {
  return [
    {
      key: 'name',
      header: 'Customer',
      cell: (c) => <CellTitle title={<Link href={hrefWith('/customers', { q, customer: c.id })} scroll={false}>{customerName(c)}</Link>} caption={c.externalRef ? `ref ${c.externalRef}` : 'no external reference'} />,
    },
    {
      key: 'ids',
      header: 'Identities',
      cell: (c) => (
        <span className="ops-ids">
          {c.identities.length ? c.identities.slice(0, 3).map((i, n) => <span key={`${i.kind}-${n}`} className="chip">{`${humanizeCode(i.kind).toLowerCase()} · ${i.display ?? 'hidden'}`}</span>) : <span className="mono-sm">none</span>}
          {c.identities.length > 3 ? <span className="mono-sm">+{c.identities.length - 3}</span> : null}
        </span>
      ),
    },
    { key: 'lang', header: 'Language', cell: (c) => <span className="mono-sm">{c.language ?? '—'}</span> },
    { key: 'updated', header: 'Updated', cell: (c) => <span className="mono-sm">{formatDateTime(c.updatedAt, zone)}</span> },
  ];
}

/** Customer search and detail (docs/03 Customer + CustomerIdentity). Execs see customers they have a permitted conversation with. */
export async function CustomersBody({ searchParams }: { searchParams: SearchParams }) {
  const [session, params] = await Promise.all([requireSession(), searchParams]);
  if (!hasPermission(session, Permission.CUSTOMERS_READ)) return <NotPermitted role={session.roleLabel} />;
  const q = param(params, 'q')?.trim().slice(0, 200) || undefined;
  const selected = idParam(params, 'customer');
  const [customers, panel] = await Promise.all([searchCustomers(q, 100), selected ? loadCustomerPanel(session, selected) : Promise.resolve(null)]);
  const zone = session.user.deployment.timezone;
  const scoped = !hasPermission(session, Permission.CUSTOMERS_MANAGE);

  return (
    <>
      <Form action="/customers" className="ops-search" role="search" aria-label="Search customers">
        <label htmlFor="customer-q" className="sr-only">
          Search customers
        </label>
        <input id="customer-q" name="q" type="search" defaultValue={q} placeholder="Name, external reference or identity (phone, email, visitor)" maxLength={200} />
        <button type="submit" className="btn">
          Search
        </button>
        {q ? (
          <Link className="btn ghost" href="/customers">
            Clear
          </Link>
        ) : null}
      </Form>
      <SecHead
        title={q ? `Results for “${q}”` : 'Customers'}
        count={customers.length === 100 ? '100 shown' : customers.length}
        desc={scoped ? 'customers you have a permitted conversation with' : 'most recently updated first'}
      />
      <DataTable
        label="Customers"
        columns={columns(q, zone)}
        rows={customers}
        rowKey={(c) => c.id}
        selectedKey={selected ?? null}
        template="minmax(0,1.3fr) minmax(0,1.6fr) 90px 110px"
        empty={
          <EmptyState title={q ? 'No customer matches' : 'No customers yet'}>
            {q
              ? 'Search matches the display name, the external reference and any channel identity. Try part of a phone number or the CRM id.'
              : 'Customers are created automatically when someone first contacts this deployment on a channel; their identities across WhatsApp, web chat, app and email resolve to one profile.'}
          </EmptyState>
        }
      />
      {panel ? (
        <RoutedDrawer
          title={panel.kind === 'ok' ? customerName(panel.customer) : 'Customer'}
          sub={panel.kind === 'ok' ? `${panel.customer.identities.length} identit${panel.customer.identities.length === 1 ? 'y' : 'ies'} · ${panel.customer.conversations.length} conversation${panel.customer.conversations.length === 1 ? '' : 's'}` : 'not available'}
          closeHref={hrefWith('/customers', { q })}
        >
          <CustomerDetailView panel={panel} session={session} />
        </RoutedDrawer>
      ) : null}
    </>
  );
}
