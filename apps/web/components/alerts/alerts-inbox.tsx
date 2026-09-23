import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { AlertBanner } from '@/components/ui/alert-banner';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { alertCounts, getAlert, listAlerts, type AlertDetail } from '@/lib/api/alerts';
import { ApiError } from '@/lib/api/errors';
import { listUsers } from '@/lib/api/users';
import { formatAge } from '@/lib/format';
import { hasPermission, type Session } from '@/lib/session';
import { KindChip, SeverityChip, StateChip } from './alert-chips';
import { AlertDrawer } from './alert-drawer';
import { alertsHref, type AlertsParams, type StatusFilter } from './alerts-meta';

const STATUS_CHIPS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'UNRESOLVED', label: 'Unresolved' },
  { key: 'OPEN', label: 'Unacked' },
  { key: 'ACKNOWLEDGED', label: 'Acked' },
  { key: 'RESOLVED', label: 'Resolved' },
  { key: 'ALL', label: 'All' },
];

async function detailOrNull(id: string): Promise<AlertDetail | null> {
  try {
    return await getAlert(id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

function Chip({ href, on, children, count }: { href: string; on: boolean; children: string; count?: number | undefined }) {
  return (
    <Link className={on ? 'fchip active' : 'fchip'} aria-current={on ? 'true' : undefined} href={href} scroll={false}>
      {children}
      {count !== undefined ? <span className="fchip-count">{count}</span> : null}
    </Link>
  );
}

/** Role-scoped alert inbox: the API returns only alerts whose audience includes the user's role and whose kind they may read. */
export async function AlertsInbox({ session, params }: { session: Session; params: AlertsParams }) {
  const status = params.status ?? 'UNRESOLVED';
  const [counts, page, detail, users] = await Promise.all([
    alertCounts(),
    listAlerts({ status: status === 'ALL' ? undefined : status, kind: params.kind, severity: params.severity, cursor: params.cursor, limit: 50 }),
    params.alert ? detailOrNull(params.alert) : Promise.resolve(null),
    hasPermission(session, Permission.USERS_READ) ? listUsers().catch(() => []) : Promise.resolve([]),
  ]);
  const kinds = Object.keys(counts.byKind);
  const base: AlertsParams = { status, kind: params.kind, severity: params.severity };
  const statusCount: Partial<Record<StatusFilter, number>> = { UNRESOLVED: counts.unresolved, OPEN: counts.open, ACKNOWLEDGED: counts.acknowledged };
  const names = Object.fromEntries([...users.map((u) => [u.id, u.name] as const), [session.user.id, `${session.user.name} (you)`] as const]);

  return (
    <>
      <div className="al-filters" aria-label="Alert filters">
        <div className="grp" role="group" aria-label="Status">
          {STATUS_CHIPS.map((c) => (
            <Chip key={c.key} href={alertsHref({ ...base, status: c.key })} on={status === c.key} count={statusCount[c.key]}>
              {c.label}
            </Chip>
          ))}
        </div>
        {kinds.length > 1 ? (
          <div className="grp" role="group" aria-label="Kind">
            <Chip href={alertsHref({ ...base, kind: undefined })} on={!params.kind}>
              All kinds
            </Chip>
            {(['TECHNICAL', 'BUSINESS'] as const).map((k) => (
              <Chip key={k} href={alertsHref({ ...base, kind: k })} on={params.kind === k} count={counts.byKind[k]}>
                {k === 'TECHNICAL' ? 'Technical' : 'Business'}
              </Chip>
            ))}
          </div>
        ) : null}
        <div className="grp" role="group" aria-label="Severity">
          <Chip href={alertsHref({ ...base, severity: undefined })} on={!params.severity}>
            Any severity
          </Chip>
          {(['CRITICAL', 'WARNING', 'INFO'] as const).map((s) => (
            <Chip key={s} href={alertsHref({ ...base, severity: s })} on={params.severity === s} count={status === 'UNRESOLVED' ? counts.bySeverity[s] : undefined}>
              {s.charAt(0) + s.slice(1).toLowerCase()}
            </Chip>
          ))}
        </div>
      </div>

      {params.alert && !detail ? (
        <AlertBanner tone="warn" title="Alert not available">
          It does not exist or is not addressed to your role.
        </AlertBanner>
      ) : null}

      <DataTable
        label="Alerts"
        template="minmax(0,1.6fr) 92px 92px minmax(0,0.8fr) 70px 90px"
        rows={page.items}
        rowKey={(a) => a.id}
        selectedKey={detail?.id ?? null}
        empty={
          <EmptyState title={status === 'UNRESOLVED' ? 'Nothing needs attention' : 'No alerts match'}>
            {status === 'UNRESOLVED'
              ? 'No open or acknowledged alert is addressed to your role. Rules keep evaluating every minute.'
              : 'Try another filter. Only alerts addressed to your role are listed.'}
          </EmptyState>
        }
        columns={[
          {
            key: 'alert',
            header: 'Alert',
            cell: (a) => (
              <Link className="cell-btn" href={alertsHref({ ...base, cursor: params.cursor, alert: a.id })} scroll={false}>
                <b style={{ fontSize: 12.5 }}>{a.title}</b>
                <span className="mono-sm" style={{ display: 'block' }}>
                  {[a.value, a.ruleName, a.occurrences > 1 ? `${a.occurrences}×` : null].filter(Boolean).join(' · ')}
                </span>
              </Link>
            ),
          },
          { key: 'kind', header: 'Kind', cell: (a) => <KindChip kind={a.kind} /> },
          { key: 'severity', header: 'Severity', cell: (a) => <SeverityChip severity={a.severity} /> },
          { key: 'source', header: 'Source', cell: (a) => <span className="mono-sm">{a.source}</span> },
          { key: 'age', header: 'Age', cell: (a) => <span className="mono">{formatAge(a.openedAt)}</span> },
          { key: 'state', header: 'State', cell: (a) => <StateChip status={a.status} /> },
        ]}
      />
      <div className="rowsplit" style={{ marginTop: 10 }}>
        {params.cursor ? (
          <Link className="btn tiny ghost" href={alertsHref(base)} scroll={false}>
            ← Newest
          </Link>
        ) : null}
        <span className="sp" />
        {page.nextCursor ? (
          <Link className="btn tiny ghost" href={alertsHref({ ...base, cursor: page.nextCursor })} scroll={false}>
            Older →
          </Link>
        ) : null}
      </div>

      {detail ? (
        <AlertDrawer
          key={`${detail.id}-${detail.status}`}
          alert={detail}
          names={names}
          canAct={hasPermission(session, Permission.ALERTS_ACKNOWLEDGE)}
          timeZone={session.user.deployment.timezone}
          closeHref={alertsHref({ ...base, cursor: params.cursor })}
        />
      ) : null}
    </>
  );
}
