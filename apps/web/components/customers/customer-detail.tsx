import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { humanizeCode } from '@/components/analytics/metrics';
import { ControlState, controlStateKind } from '@/components/ui/control-state';
import { EmptyState } from '@/components/ui/empty-state';
import { KeyValue } from '@/components/ui/key-value';
import { StatusChip } from '@/components/ui/status-chip';
import { loadCustomerDetail, type CustomerDetail } from '@/lib/api/customers';
import { ApiError } from '@/lib/api/errors';
import { listAgentOptions } from '@/lib/api/quality';
import { listUsers } from '@/lib/api/users';
import { formatDateTime } from '@/lib/format';
import { hasPermission, type Session } from '@/lib/session';
import { CustomerEdit } from './customer-edit';
import { attributeText } from './forms';

export type CustomerPanel =
  | { kind: 'ok'; customer: CustomerDetail; agents: Map<string, string>; owners: Array<{ value: string; label: string }> | null }
  | { kind: 'unavailable'; message: string };

/** Detail + the names it needs (agents: agents.read; account owners: users.read). 403/404 become an explanation, not an error page. */
export async function loadCustomerPanel(session: Session, id: string): Promise<CustomerPanel> {
  try {
    const [customer, agents, users] = await Promise.all([
      loadCustomerDetail(id),
      hasPermission(session, Permission.AGENTS_READ) ? listAgentOptions() : Promise.resolve([]),
      hasPermission(session, Permission.USERS_READ) ? listUsers() : Promise.resolve(null),
    ]);
    return {
      kind: 'ok',
      customer,
      agents: new Map(agents.map((a) => [a.id, a.name])),
      owners: users ? users.filter((u) => u.status === 'ACTIVE' && u.role !== 'TECH').map((u) => ({ value: u.id, label: u.name })) : null,
    };
  } catch (err) {
    if (err instanceof ApiError && (err.isForbidden || err.status === 404)) {
      return { kind: 'unavailable', message: 'This customer does not exist, or you have no permitted conversation with them.' };
    }
    throw err;
  }
}

/** Customer drawer body: identities, attributes, conversations; edit for customers.manage. */
export function CustomerDetailView({ panel, session }: { panel: CustomerPanel; session: Session }) {
  if (panel.kind === 'unavailable') return <EmptyState title="Customer not available">{panel.message}</EmptyState>;
  const { customer: c, agents, owners } = panel;
  const zone = session.user.deployment.timezone;
  const ownerName = c.accountOwnerUserId ? (owners?.find((o) => o.value === c.accountOwnerUserId)?.label ?? 'assigned') : 'none';
  const attrs = Object.entries(c.attributes);

  return (
    <>
      <KeyValue
        template="minmax(90px,110px) minmax(0,1fr)"
        items={[
          { k: 'external ref', v: c.externalRef ?? '—' },
          { k: 'language', v: c.language ?? '—' },
          { k: 'account owner', v: ownerName },
          { k: 'customer since', v: formatDateTime(c.createdAt, zone) },
          { k: 'context', v: <span className="mono-sm">version {c.contextVersion} · updated {formatDateTime(c.updatedAt, zone)}</span> },
        ]}
      />
      <section aria-labelledby="cu-ids">
        <h3 id="cu-ids" className="grp">
          Identities · {c.identities.length}
        </h3>
        {c.identities.length ? (
          <div className="ops-list">
            {c.identities.map((i, n) => (
              <div className="rowsplit" key={`${i.kind}-${n}`}>
                <span className="mono-sm">{humanizeCode(i.kind).toLowerCase()}</span>
                <span>{i.display ?? 'hidden'}</span>
                <span className="sp" />
                <StatusChip tone={i.verified ? 'good' : 'muted'}>{i.verified ? 'verified' : 'unverified'}</StatusChip>
              </div>
            ))}
          </div>
        ) : (
          <span className="mono-sm">no channel identities</span>
        )}
      </section>
      <section aria-labelledby="cu-attrs">
        <h3 id="cu-attrs" className="grp">
          Attributes · {attrs.length}
        </h3>
        {attrs.length ? <KeyValue template="minmax(90px,110px) minmax(0,1fr)" items={attrs.map(([k, v]) => ({ k, v: attributeText(v) }))} /> : <span className="mono-sm">none recorded</span>}
      </section>
      <section aria-labelledby="cu-convs">
        <h3 id="cu-convs" className="grp">
          Conversations · {c.conversations.length}
        </h3>
        {c.conversations.length ? (
          <div className="ops-convs">
            {c.conversations.map((v) => (
              <Link key={v.id} href={`/conversations/${v.id}`} className="ops-conv">
                <span className="rowsplit">
                  <ControlState state={controlStateKind(v.controlState)} />
                  <span className="mono-sm">{agents.get(v.agentId) ?? 'agent'}</span>
                  <span className="sp" />
                  <span className="mono-sm">{formatDateTime(v.openedAt, zone)}</span>
                </span>
                <span className="ops-preview">{v.lastPreview ?? 'no messages yet'}</span>
              </Link>
            ))}
          </div>
        ) : (
          <span className="mono-sm">no conversations</span>
        )}
      </section>
      {hasPermission(session, Permission.CUSTOMERS_MANAGE) ? (
        <CustomerEdit customer={{ id: c.id, displayName: c.displayName, language: c.language, externalRef: c.externalRef, attributes: c.attributes, accountOwnerUserId: c.accountOwnerUserId }} owners={owners} />
      ) : null}
    </>
  );
}
