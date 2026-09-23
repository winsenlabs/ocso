import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { KeyValue } from '@/components/ui/key-value';
import { SecHead } from '@/components/ui/sec-head';
import { StatusChip } from '@/components/ui/status-chip';
import { AlertBanner } from '@/components/ui/alert-banner';
import { readAuditLog, type AuditEvent } from '@/lib/api/audit';
import { listUsers } from '@/lib/api/users';
import { formatDateTime } from '@/lib/format';
import { hasPermission, requireSession } from '@/lib/session';
import { AuditDiff } from './audit-diff';
import { AuditDrawer } from './audit-drawer';
import { AuditFilters } from './audit-filters';
import { auditHref, parseAuditParams, toApiFilter } from './audit-meta';

const PAGE = 100;
const VIA_TONE: Record<string, 'accent' | 'muted'> = { INTERNAL_AGENT: 'accent' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function actorLabel(e: AuditEvent): string {
  return e.actorName ?? (e.actorType === 'SYSTEM' ? 'automation' : (e.actorId ?? e.actorType.toLowerCase()));
}

/** The immutable audit log (GET /v1/audit, docs/15 §7): filterable, newest first, with a before/after view per entry. */
export async function AuditBody({ searchParams }: { searchParams: SearchParams }) {
  const [session, raw] = await Promise.all([requireSession(), searchParams]);
  if (!hasPermission(session, Permission.AUDIT_READ)) return <NotPermitted role={session.roleLabel} />;
  const params = parseAuditParams(raw);
  const tz = session.user.deployment.timezone;
  const [{ rows, source }, users] = await Promise.all([
    readAuditLog(toApiFilter(params, PAGE)),
    hasPermission(session, Permission.USERS_READ) ? listUsers().catch(() => []) : Promise.resolve([]),
  ]);
  const selected = params.entry ? rows.find((r) => r.id === params.entry) : undefined;
  const filters = { ...params, entry: undefined };
  const last = rows[rows.length - 1];

  return (
    <>
      {source === 'local' ? (
        <AlertBanner tone="warn" title="Showing the local copy only" style={{ margin: '0 0 12px' }}>
          The audit store did not answer, so these entries come from the main database&apos;s local window. Older events are safe in the store but are not listed
          until it answers again.
        </AlertBanner>
      ) : null}
      <AuditFilters params={params} actors={users.map((u) => ({ id: u.id, name: u.name }))} />
      <SecHead
        title="Entries"
        count={rows.length === PAGE ? `latest ${PAGE}` : rows.length}
        desc="immutable · payloads redacted when written · times in the deployment timezone"
      />
      <DataTable
        label="Audit entries"
        template="118px minmax(0,1.7fr) minmax(0,0.9fr) minmax(0,0.9fr) 104px"
        rows={rows}
        rowKey={(r) => r.id}
        selectedKey={selected?.id ?? null}
        empty={
          <EmptyState title="No audit entries match">
            Configuration changes, role changes, alert acknowledgements and sensitive actions are recorded here as they happen.
          </EmptyState>
        }
        columns={[
          { key: 'at', header: 'When', cell: (r) => <span className="mono-sm">{formatDateTime(r.occurredAt, tz)}</span> },
          {
            key: 'what',
            header: 'Change',
            cell: (r) => (
              <Link className="cell-btn" href={auditHref({ ...filters, entry: r.id })} scroll={false}>
                <b style={{ fontSize: 12.5 }}>{r.summary}</b>
                <span className="mono-sm" style={{ display: 'block' }}>
                  {r.action}
                </span>
              </Link>
            ),
          },
          {
            key: 'target',
            header: 'Target',
            cell: (r) => (
              <span className="mono-sm">
                {r.targetType.replace(/_/g, ' ')}
                {r.targetId ? ` · ${r.targetId.slice(0, 8)}` : ''}
              </span>
            ),
          },
          { key: 'actor', header: 'Actor', cell: (r) => <span className="mono-sm">{actorLabel(r)}</span> },
          { key: 'via', header: 'Via', cell: (r) => <StatusChip tone={VIA_TONE[r.via] ?? 'muted'}>{r.via.toLowerCase().replace(/_/g, ' ')}</StatusChip> },
        ]}
      />
      <div className="rowsplit" style={{ marginTop: 10 }}>
        {params.before ? (
          <Link className="btn tiny ghost" href={auditHref({ ...filters, before: undefined, beforeId: undefined })} scroll={false}>
            ← Newest
          </Link>
        ) : null}
        <span className="sp" />
        {rows.length === PAGE && last ? (
          <Link className="btn tiny ghost" href={auditHref({ ...filters, before: last.occurredAt, beforeId: last.id })} scroll={false}>
            Older →
          </Link>
        ) : null}
      </div>

      {selected ? (
        <AuditDrawer title={selected.summary} sub={`${selected.action} · ${formatDateTime(selected.occurredAt, tz)}`} closeHref={auditHref(filters)}>
          <KeyValue
            template="minmax(96px,110px) minmax(0,1fr)"
            items={[
              { k: 'actor', v: `${actorLabel(selected)} · ${selected.actorType.toLowerCase()}` },
              { k: 'via', v: selected.via.toLowerCase().replace(/_/g, ' ') },
              { k: 'target', v: `${selected.targetType}${selected.targetId ? ` · ${selected.targetId}` : ''}` },
              { k: 'correlation', v: <span className="mono-sm">{selected.correlationId ?? '—'}</span> },
              { k: 'entry', v: <span className="mono-sm">{selected.id}</span> },
              ...(selected.ip ? [{ k: 'ip', v: selected.ip }] : []),
            ]}
          />
          <div>
            <div className="grp" style={{ marginBottom: 6 }}>
              before / after
            </div>
            <AuditDiff before={selected.before} after={selected.after} />
          </div>
          {selected.confirmation ? (
            <div>
              <div className="grp" style={{ marginBottom: 6 }}>
                confirmation
              </div>
              <pre className="al-json">{JSON.stringify(selected.confirmation, null, 2)}</pre>
            </div>
          ) : null}
        </AuditDrawer>
      ) : null}
    </>
  );
}
