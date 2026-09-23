import Link from 'next/link';
import { EmptyState } from '@/components/ui/empty-state';
import { DayList, RailCard } from '@/components/ui/rail-card';
import type { PrivilegedChange } from '@/lib/api/telemetry';
import { formatDateTime, formatTime } from '@/lib/format';

/** Short audit reference as the design writes it ("aud_88e2"). */
export function auditRef(id: string): string {
  return `aud_${id.replace(/-/g, '').slice(-4)}`;
}

/** "09:12" today, "21 Sep" before — both in the deployment timezone. */
function when(iso: string, timeZone: string): string {
  const day = (value: string) => formatDateTime(value, timeZone).split(' ').slice(0, 2).join(' ');
  return day(iso) === day(new Date().toISOString()) ? formatTime(iso, timeZone) : day(iso);
}

/** Recent privileged configuration changes from the immutable audit log (design/06 admin rail, design/03). */
export function ChangesCard({ changes, timeZone, canAudit }: { changes: PrivilegedChange[]; timeZone: string; canAudit: boolean }) {
  return (
    <RailCard title="Recent privileged changes" count={changes.length || undefined}>
      {changes.length ? (
        <DayList
          rows={changes.map((c) => ({
            key: c.id,
            time: when(c.occurredAt, timeZone),
            label: c.summary,
            who: `${c.actorName ?? (c.actorType === 'SYSTEM' ? 'automation' : c.actorType.toLowerCase())} · ${auditRef(c.id)}`,
          }))}
        />
      ) : (
        <EmptyState size="sm" title="No privileged changes yet">
          Worker, provider, connection, role and alert configuration changes appear here, attributed to the person who made them.
        </EmptyState>
      )}
      {canAudit ? (
        <div className="rowsplit" style={{ marginTop: 10 }}>
          <Link className="btn tiny ghost" href="/audit">
            Audit log
          </Link>
        </div>
      ) : null}
    </RailCard>
  );
}
