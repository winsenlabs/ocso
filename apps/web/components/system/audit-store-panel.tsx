import { AlertBanner } from '@/components/ui/alert-banner';
import { KeyValue, type KeyValueItem } from '@/components/ui/key-value';
import { StatusChip, type StatusTone } from '@/components/ui/status-chip';
import type { AuditStoreStatus } from '@/lib/api/audit-store';
import { formatCompact, formatDateTime, formatDuration } from '@/lib/format';
import { AuditVerifyButton } from './audit-verify-button';
import { ChainBreakAcknowledge } from './chain-break-acknowledge';

const TONE: Record<AuditStoreStatus['status'], StatusTone> = { OK: 'good', DEGRADED: 'warn', DOWN: 'danger' };

/** Incident kinds in plain words (what the exception report calls them too). */
const INCIDENT: Record<string, string> = {
  SHIP_FAILED: 'Shipping to the audit store failed',
  STORE_DOWN: 'The audit store is unreachable',
  RECONCILE_MISSING: 'The store was missing shipped events (re-sent)',
  CHAIN_BROKEN: 'The hash chain did not verify',
  EXPORT_FAILED: 'The signed export failed or is blocked',
  SIGNING_KEY_CHANGED: 'Checkpoints were signed by a key this deployment does not trust',
};

function bytes(n: number | null): string {
  if (n === null) return 'size unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 10 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/**
 * The audit store panel (System screen, ADR-032): where audit events are the
 * system of record, how far behind shipping is, how much is sealed and signed,
 * the exports, open incidents, and an on-demand verification of the latest
 * entries (audit.verify).
 */
export function AuditStorePanel({ data, timeZone, canVerify }: { data: AuditStoreStatus | null; timeZone: string; canVerify: boolean }) {
  if (!data) {
    return (
      <section className="ch" aria-label="Audit store">
        <div className="t">
          <h3>Audit store</h3>
        </div>
        <p className="mono-sm" style={{ margin: 0 }}>
          The audit store status could not be loaded.
        </p>
      </section>
    );
  }
  const items: KeyValueItem[] = [
    { k: 'Driver', v: `${data.driver} · ${data.health.ok ? `${data.health.latencyMs} ms` : 'not answering'}` },
    {
      k: 'Shipping',
      v: data.unshipped ? `${data.unshipped} waiting · oldest ${formatDuration(data.lagSeconds)} ago` : 'up to date',
    },
    { k: 'Verifying', v: data.unverified ? `${data.unverified} shipped, awaiting reconciliation` : 'all shipped events confirmed' },
    { k: 'Sealed', v: data.sealedPosition === null ? 'nothing sealed yet' : `chain position ${formatCompact(data.sealedPosition)}` },
    {
      k: 'Checkpoint',
      v: data.lastCheckpoint ? `#${data.lastCheckpoint.upToPosition} · ${formatDateTime(data.lastCheckpoint.createdAt, timeZone)} · key ${data.lastCheckpoint.keyId}` : 'none signed yet',
    },
    {
      k: 'Stored',
      v: data.store ? `${formatCompact(data.store.rows)} events · ${bytes(data.store.bytes)}${data.store.oldest ? ` · since ${formatDateTime(data.store.oldest, timeZone)}` : ''}` : '—',
    },
    {
      k: 'Exports',
      v: data.exports.last
        ? `${data.exports.count} · last #${data.exports.last.fromPosition}–${data.exports.last.toPosition} on ${formatDateTime(data.exports.last.createdAt, timeZone)}`
        : 'none yet (daily, up to the latest checkpoint)',
    },
    {
      k: 'Signing key',
      v: data.signingKey ? `${data.signingKey.keyId}${data.signingKey.retired.length ? ` · also trusts ${data.signingKey.retired.join(', ')}` : ''}` : 'not configured',
    },
    {
      k: 'Full check',
      v: data.fullVerification
        ? `${data.fullVerification.ok ? 'passed' : `${data.fullVerification.problems} problem${data.fullVerification.problems === 1 ? '' : 's'}`} · ${formatCompact(data.fullVerification.entries)} entries · ${formatDateTime(data.fullVerification.finishedAt, timeZone)}`
        : 'not run yet (daily, the whole chain)',
    },
  ];
  return (
    <section className="ch" aria-label="Audit store">
      <div className="t">
        <h3>Audit store</h3>
        <StatusChip tone={TONE[data.status]}>{data.status.toLowerCase()}</StatusChip>
      </div>
      {data.status === 'DOWN' ? (
        <AlertBanner tone="error" title="The audit store is not answering" style={{ margin: 0 }}>
          OCSO keeps working: every audit event stays in the main database and ships when the store is back. The audit log shows the local copy meanwhile.
        </AlertBanner>
      ) : null}
      {data.incidents.map((i) => (
        <AlertBanner key={i.id} tone={i.kind === 'CHAIN_BROKEN' ? 'error' : 'warn'} title={INCIDENT[i.kind] ?? i.kind} style={{ margin: 0 }}>
          Seen {i.count} time{i.count === 1 ? '' : 's'} since {formatDateTime(i.firstSeen, timeZone)}, last {formatDateTime(i.lastSeen, timeZone)}.
          {i.kind === 'CHAIN_BROKEN' && typeof i.detail['firstBrokenAt'] === 'number' ? (
            <>
              {' '}
              Entries #{String(i.detail['firstBrokenAt'])}–{String(i.detail['lastBrokenAt'])} do not verify; later ranges are still checkpointed.
            </>
          ) : null}
          {i.kind === 'CHAIN_BROKEN' && canVerify ? <ChainBreakAcknowledge incidentId={i.id} /> : null}
        </AlertBanner>
      ))}
      {data.warnings.map((w) => (
        <AlertBanner key={w} tone="warn" title="Audit store access" style={{ margin: 0 }}>
          {w}
        </AlertBanner>
      ))}
      <KeyValue template="minmax(90px,110px) minmax(0,1fr)" items={items} />
      {canVerify ? <AuditVerifyButton /> : null}
    </section>
  );
}
