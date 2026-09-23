import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { AlertBanner } from '@/components/ui/alert-banner';
import { KeyValue, type KeyValueItem } from '@/components/ui/key-value';
import { StatusChip } from '@/components/ui/status-chip';
import { ApiError } from '@/lib/api/errors';
import { loadExceptionReport, type ExceptionReportDetail } from '@/lib/api/exceptions';
import { formatDateTime } from '@/lib/format';
import { hasPermission, requireSession } from '@/lib/session';
import { ExceptionSections, ExceptionTotals } from './exception-sections';
import { ATTESTATION_TEXT, KEY_TRUST_TEXT, SIGN_BLOCKED_TEXT, VERIFICATION_TEXT, periodLabel } from './exceptions-meta';
import { RegenerateReportForm } from './regenerate-form';
import { SignReportForm } from './sign-form';

async function reportOrNull(id: string): Promise<ExceptionReportDetail | null> {
  try {
    return await loadExceptionReport(id);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) return null;
    throw err;
  }
}

/** One report: period, status, signature and its verification, sign form, export, and every check. */
export async function ReportDetail({ params }: { params: Promise<{ id: string }> }) {
  const [session, { id }] = await Promise.all([requireSession(), params]);
  if (!hasPermission(session, Permission.EXCEPTIONS_READ)) return <NotPermitted role={session.roleLabel} />;
  const report = await reportOrNull(id);
  const tz = session.user.deployment.timezone;
  if (!report) {
    return (
      <AlertBanner tone="warn" title="Report not found">
        <Link href="/exceptions?view=reports">Back to the reports</Link>
      </AlertBanner>
    );
  }
  const verification = report.verification ? VERIFICATION_TEXT[report.verification] : null;
  const trust = report.keyTrust ? KEY_TRUST_TEXT[report.keyTrust] : undefined;
  const blocked = report.signBlocked ? SIGN_BLOCKED_TEXT[report.signBlocked] : undefined;
  const status = report.status === 'SIGNED' ? { tone: 'good' as const, text: 'signed' } : report.status === 'SUPERSEDED' ? { tone: 'muted' as const, text: 'superseded' } : { tone: 'warn' as const, text: 'awaiting signature' };
  const facts: KeyValueItem[] = [
    { k: 'Period', v: `${periodLabel(report.periodStart, report.periodEnd, report.timezone)} (${report.timezone})` },
    { k: 'Generated', v: `${formatDateTime(report.generatedAt, tz)} · ${report.generatedBy ? report.generatedBy.name : 'weekly schedule'}` },
    { k: 'Content hash', v: <code className="mono-sm">{report.contentHash}</code> },
    ...(report.status === 'SIGNED'
      ? [
          { k: 'Signed', v: `${report.signedBy?.name ?? '—'} · ${formatDateTime(report.signedAt, tz)}` },
          ...(report.signNote ? [{ k: 'Note', v: report.signNote }] : []),
          { k: 'Attests', v: report.attestation.length ? report.attestation.map((f) => ATTESTATION_TEXT[f]?.short ?? f).join(', ') : 'nothing to declare' },
          { k: 'Key', v: <code className="mono-sm">{report.keyId}</code> },
        ]
      : []),
  ];
  return (
    <div className="exc-report" data-report={report.id}>
      <section className="ch" aria-label="Report summary">
        <div className="t">
          <h3>{report.kind === 'WEEKLY' ? 'Weekly report' : 'Ad-hoc report'}</h3>
          <StatusChip tone={status.tone}>{status.text}</StatusChip>
          {verification ? <StatusChip tone={verification.tone}>{verification.text}</StatusChip> : null}
          {trust ? <StatusChip tone={trust.tone}>{trust.text}</StatusChip> : null}
          {report.attestation.includes('self_attested') ? <StatusChip tone="warn">self-attested</StatusChip> : null}
        </div>
        <KeyValue items={facts} template="minmax(90px,120px) minmax(0,1fr)" />
        <ExceptionTotals content={report.content} />
        {report.scoped ? (
          <AlertBanner tone="info" title="Your teams’ view" style={{ margin: 0 }}>
            This is the part of the report about your teams and the platform. The signature covers the whole report, which signers see.
          </AlertBanner>
        ) : null}
        {report.supersededBy ? (
          <AlertBanner tone="info" title="Replaced by a regenerated report" style={{ margin: 0 }}>
            <Link href={`/exceptions/reports/${report.supersededBy}`}>Open the current report</Link>
          </AlertBanner>
        ) : null}
        {blocked ? (
          <AlertBanner tone="warn" title="Cannot be signed here" style={{ margin: 0 }}>
            {blocked}
          </AlertBanner>
        ) : null}
        {report.canSign ? <SignReportForm reportId={report.id} contentHash={report.contentHash} attestation={report.attestationRequired} /> : null}
        {report.canRegenerate ? <RegenerateReportForm reportId={report.id} /> : null}
        {report.canExport ? (
          <div className="rowsplit" style={{ gap: 8, alignItems: 'center' }}>
            {/* A download, not a page: a plain anchor so the browser saves the zip. */}
            <a className="btn" href={`/exceptions/reports/${report.id}/export`} download>
              Download signed export
            </a>
            <span className="mono-sm">report.json + items.csv, the signature, the public key and how to verify them</span>
          </div>
        ) : null}
      </section>
      <ExceptionSections content={report.content} timeZone={tz} />
    </div>
  );
}
