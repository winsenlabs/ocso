import Link from 'next/link';
import { AlertBanner } from '@/components/ui/alert-banner';
import { StatusChip } from '@/components/ui/status-chip';
import type { ExceptionContent } from '@/lib/api/exceptions';
import { formatDateTime } from '@/lib/format';
import { SEVERITY_TONE, itemHref } from './exceptions-meta';

/**
 * Every check of a report, in report order: what it looks at, its items, and
 * — when the check itself failed — the error (a report never hides a check).
 * Checks with nothing to report are listed compactly at the end.
 */
export function ExceptionSections({ content, timeZone }: { content: ExceptionContent; timeZone: string }) {
  const incomplete = (s: ExceptionContent['sections'][number]) => Boolean(s.coverage && !s.coverage.complete);
  const found = content.sections.filter((s) => s.total > 0 || s.error || incomplete(s));
  const clean = content.sections.filter((s) => s.total === 0 && !s.error && !incomplete(s));
  return (
    <div className="exc-sections">
      {found.map((s) => (
        <section key={s.id} className="ch exc-section" aria-labelledby={`exc-${s.id}`} data-check={s.id}>
          <div className="t">
            <h3 id={`exc-${s.id}`}>{s.label}</h3>
            <StatusChip tone={SEVERITY_TONE[s.severity] ?? 'muted'}>{s.severity}</StatusChip>
            <span className="mono-sm">
              {s.error ? 'check failed' : `${s.total} item${s.total === 1 ? '' : 's'}${s.truncated ? ` · first ${s.items.length} listed` : ''}`}
            </span>
          </div>
          <p className="exc-desc">{s.description}</p>
          {s.error ? (
            <AlertBanner tone="error" title="This check could not run" style={{ margin: 0 }}>
              Error class: <code className="mono-sm">{s.error}</code>. The details are in the server log.
            </AlertBanner>
          ) : null}
          {s.coverage && !s.coverage.complete ? (
            <AlertBanner tone="warn" title="May be incomplete" style={{ margin: 0 }}>
              The history this check reads is kept from {formatDateTime(s.coverage.dataFrom, timeZone)}; the period starts earlier.
            </AlertBanner>
          ) : null}
          {s.items.length ? (
            <ul className="exc-items">
              {s.items.map((i, n) => {
                const href = itemHref(i);
                return (
                  <li key={`${i.objectKind}:${i.objectId ?? ''}:${n}`}>
                    <div className="exc-title">{href ? <Link href={href}>{i.title}</Link> : i.title}</div>
                    <div className="exc-detail">{i.detail}</div>
                    <div className="mono-sm">
                      {formatDateTime(i.occurredAt, timeZone)} · {i.objectKind}
                      {i.teamIds.length ? '' : ' · platform-wide'}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>
      ))}
      {clean.length ? (
        <section className="ch" aria-label="Checks with nothing to report">
          <div className="t">
            <h3>Nothing to report</h3>
            <span className="mono-sm">
              {clean.length} check{clean.length === 1 ? '' : 's'}
            </span>
          </div>
          <ul className="exc-clean">
            {clean.map((s) => (
              <li key={s.id} title={s.description}>
                <StatusChip tone="good">clear</StatusChip> {s.label}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** One line of totals: items by severity and failed checks. */
export function ExceptionTotals({ content }: { content: ExceptionContent }) {
  const t = content.totals;
  return (
    <div className="exc-totals" aria-label="Totals">
      <StatusChip tone={t.items ? 'warn' : 'good'}>
        {t.items} item{t.items === 1 ? '' : 's'}
      </StatusChip>
      {(['critical', 'high', 'medium', 'low'] as const).map((sev) =>
        t.bySeverity[sev] ? (
          <StatusChip key={sev} tone={SEVERITY_TONE[sev] ?? 'muted'}>
            {t.bySeverity[sev]} {sev}
          </StatusChip>
        ) : null,
      )}
      {t.failedChecks ? <StatusChip tone="danger">{t.failedChecks} check(s) failed</StatusChip> : null}
      {t.incompleteChecks ? <StatusChip tone="warn">{t.incompleteChecks} check(s) may be incomplete</StatusChip> : null}
    </div>
  );
}
