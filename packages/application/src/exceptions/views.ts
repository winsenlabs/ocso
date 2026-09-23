import type { Principal } from '@ocso/auth';
import type { exceptionReports } from '@ocso/db';
import { scopeContent } from './compute.js';
import type { ExceptionReportContent } from './contract.js';
import type { ReportSignatureCheck } from './signing.js';

/** What the API returns for a report (list rows and the detail). */
type Row = typeof exceptionReports.$inferSelect;
const person = (id: string | null, name: string | null) => (id ? { id, name: name ?? 'Unknown user' } : null);

export interface ExceptionReportSummary {
  id: string;
  kind: Row['kind'];
  periodStart: string;
  periodEnd: string;
  /** The time zone the period was cut in (the deployment's at generation). */
  timezone: string;
  status: Row['status'];
  generatedAt: string;
  generatedBy: { id: string; name: string } | null;
  signedAt: string | null;
  signedBy: { id: string; name: string } | null;
  contentHash: string;
  totals: ExceptionReportContent['totals'];
  /** What the signer acknowledged (signed with the report): 'self_attested', 'failed_checks', … */
  attestation: string[];
  /** The regenerated report that replaced this draft. */
  supersededBy: string | null;
  /** The reader sees only their teams' items and platform-wide ones (not a signer). */
  scoped: boolean;
}

export interface ExceptionReportDetail extends ExceptionReportSummary {
  signNote: string | null;
  keyId: string | null;
  signature: string | null;
  /** For a signed report, whether the stored content and signature verify with the key stored at signing. */
  verification: ReportSignatureCheck | null;
  /** Whether that key is this server's signing key, one of its retired keys, or neither. */
  keyTrust: 'CURRENT' | 'RETIRED' | 'UNKNOWN' | null;
  content: ExceptionReportContent;
  canSign: boolean;
  /** Why a signer cannot sign it now (canSign false for a signer), e.g. 'signing_key_unavailable'. */
  signBlocked: 'signing_key_unavailable' | 'superseded' | 'signed' | null;
  /** What this reader must acknowledge to sign it (attestation.ts). */
  attestationRequired: string[];
  canRegenerate: boolean;
  canExport: boolean;
}

export function reportSummary(row: { report: Row; generatorName: string | null; signerName: string | null }, principal: Principal): ExceptionReportSummary {
  const r = row.report;
  const { content, scoped } = scopeContent(r.content as unknown as ExceptionReportContent, principal);
  return {
    id: r.id,
    kind: r.kind,
    periodStart: r.periodStart.toISOString(),
    periodEnd: r.periodEnd.toISOString(),
    timezone: content.period.timezone,
    status: r.status,
    generatedAt: r.generatedAt.toISOString(),
    generatedBy: person(r.generatedBy, row.generatorName),
    signedAt: r.signedAt?.toISOString() ?? null,
    signedBy: person(r.signedBy, row.signerName),
    contentHash: r.contentHash,
    totals: content.totals,
    attestation: [...r.attestation],
    supersededBy: r.supersededBy,
    scoped,
  };
}
