import { AlertBanner } from '@/components/ui/alert-banner';
import { KeyValue, type KeyValueItem } from '@/components/ui/key-value';
import { StatusChip, type StatusTone } from '@/components/ui/status-chip';
import type { StorageReport } from '@/lib/api/storage';
import { formatCompact, formatDateTime } from '@/lib/format';

/** 12.3 GB; null → "size unknown". */
export function formatBytes(n: number | null): string {
  if (n === null) return 'size unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.abs(n);
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${n < 0 ? '−' : ''}${v >= 10 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

const growth = (n: number | null) => (n === null ? '—' : `${n > 0 ? '+' : ''}${formatBytes(n)}`);

const GUIDANCE: Record<StorageReport['guidance']['level'], { tone: StatusTone; title: string }> = {
  ok: { tone: 'good', title: 'The audit store is well within its range' },
  consider: { tone: 'warn', title: 'Plan a move of the audit store to ClickHouse' },
  recommend: { tone: 'danger', title: 'Move the audit store to ClickHouse' },
  columnar: { tone: 'good', title: 'The audit store runs on a columnar engine' },
};

/**
 * Storage (PM/research/11 §7): the main database's size and growth from the
 * daily samples, the largest and fastest-growing tables, the audit store, and
 * when to move the audit store to ClickHouse.
 */
export function StoragePanel({ data, timeZone }: { data: StorageReport | null; timeZone: string }) {
  if (!data) {
    return (
      <section className="ch" aria-label="Storage">
        <div className="t">
          <h3>Storage</h3>
        </div>
        <p className="mono-sm" style={{ margin: 0 }}>
          The storage report could not be loaded.
        </p>
      </section>
    );
  }
  const g = GUIDANCE[data.guidance.level];
  if (!data.sampledDay) {
    return (
      <section className="ch" aria-label="Storage">
        <div className="t">
          <h3>Storage</h3>
        </div>
        <p className="mono-sm" style={{ margin: 0 }}>
          No sample yet: the worker records table sizes once a day (hourly check).
        </p>
      </section>
    );
  }
  const items: KeyValueItem[] = [
    { k: 'Main database', v: `${formatBytes(data.database.bytes)} in ${data.database.tables} tables · sampled ${formatDateTime(data.sampledAt, timeZone)}` },
    { k: 'Growth', v: `${growth(data.database.bytes7d)} in 7 days · ${growth(data.database.bytes30d)} in 30 days${data.database.bytesPerDay !== null ? ` · about ${growth(data.database.bytesPerDay)} a day` : ''}` },
    {
      k: 'Audit store',
      v:
        data.auditStore.rows === null
          ? `${data.auditStore.driver} · not sampled yet`
          : `${data.auditStore.driver} · ${formatCompact(data.auditStore.rows)} records · ${formatBytes(data.auditStore.bytes)}${data.auditStore.rowsPerDay !== null ? ` · about ${formatCompact(data.auditStore.rowsPerDay)} a day` : ''}`,
    },
  ];
  const top = [...data.tables].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)).slice(0, 8);
  return (
    <section className="ch" aria-label="Storage">
      <div className="t">
        <h3>Storage</h3>
        <StatusChip tone={g.tone}>{data.guidance.level}</StatusChip>
      </div>
      <KeyValue template="minmax(90px,110px) minmax(0,1fr)" items={items} />
      <AlertBanner tone={g.tone === 'good' ? 'info' : g.tone === 'danger' ? 'error' : 'warn'} title={g.title} style={{ margin: 0 }}>
        {data.guidance.reasons.join(' ')}
      </AlertBanner>
      <div className="dtable" role="table" aria-label="Largest tables">
        <div className="dt-head" role="row" style={{ gridTemplateColumns: 'minmax(140px,1.4fr) 90px 90px 90px 90px' }}>
          <span role="columnheader">Table</span>
          <span role="columnheader">Rows</span>
          <span role="columnheader">Size</span>
          <span role="columnheader">7 days</span>
          <span role="columnheader">30 days</span>
        </div>
        {top.map((t) => (
          <div key={t.table} className="dt-row" role="row" style={{ gridTemplateColumns: 'minmax(140px,1.4fr) 90px 90px 90px 90px' }}>
            <span role="cell" className="mono-sm">
              {t.table}
            </span>
            <span role="cell">{formatCompact(t.rows)}</span>
            <span role="cell">{formatBytes(t.bytes)}</span>
            <span role="cell" style={{ fontVariantNumeric: 'tabular-nums', ...(t.bytes7d && t.bytes7d > 0 ? { color: 'var(--warn,#d97706)' } : {}) }}>
              {growth(t.bytes7d)}
            </span>
            <span role="cell" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {growth(t.bytes30d)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
