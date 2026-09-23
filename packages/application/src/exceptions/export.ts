import { createPublicKey } from 'node:crypto';
import { keyIdOf, sha256Hex, verifySignature, type AuditPublicKey } from '@ocso/audit-store';
import type { ExceptionReportContent } from './contract.js';
import { noteHash, reportContentBytes, reportSignatureMessage } from './signing.js';
import { readZip, writeZip } from './zip.js';

/**
 * The export of a signed exception report (PM/research/11 §7): a zip an auditor
 * can verify with nothing but sha256sum and openssl.
 *   report.json          the signed content, byte for byte (canonical JSON)
 *   items.csv            every item, one row each — derived from report.json, not signed on its own
 *   manifest.json        id, period, hashes, signer, signature, key id
 *   signed-message.txt   the exact text that was signed
 *   signature.bin        the raw Ed25519 signature (base64 in manifest.json)
 *   public-key.pem       the audit signing public key
 *   VERIFY.txt           the verification steps
 */

export const EXCEPTION_EXPORT_FORMAT = 'ocso-exception-report-export/1';

export interface ExportableReport {
  id: string;
  kind: 'WEEKLY' | 'ADHOC';
  periodStart: Date;
  periodEnd: Date;
  content: ExceptionReportContent;
  contentHash: string;
  generatedAt: Date;
  signedAt: Date;
  signedBy: { id: string; name: string };
  signNote: string | null;
  attestation: string[];
  signature: string;
  keyId: string;
  /** Whether the exporting server knows the key as its current or a retired signing key. */
  keyTrust: 'CURRENT' | 'RETIRED' | 'UNKNOWN';
}

const CSV_COLUMNS = ['check', 'severity', 'object_kind', 'object_id', 'title', 'detail', 'occurred_at', 'count', 'team_ids', 'href'] as const;

function csvCell(value: string): string {
  // Leading = + - @ would run as a formula in a spreadsheet: quote them as text.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Deterministic CSV of every listed item (sections in report order). */
export function itemsCsv(content: ExceptionReportContent): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const s of content.sections) {
    if (s.error) lines.push([s.id, s.severity, '', '', `CHECK FAILED: ${s.error}`, '', content.generatedAt, '0', '', ''].map(csvCell).join(','));
    for (const i of s.items) {
      lines.push([s.id, s.severity, i.objectKind, i.objectId ?? '', i.title, i.detail, i.occurredAt, String(i.count), i.teamIds.join(' '), i.href ?? ''].map(csvCell).join(','));
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}

function verifyText(r: ExportableReport): string {
  return [
    `OCSO exception report ${r.id}`,
    `Period ${r.periodStart.toISOString()} to ${r.periodEnd.toISOString()} (${r.content.period.timezone})`,
    `Signed by ${r.signedBy.name} (${r.signedBy.id}) at ${r.signedAt.toISOString()} with key ${r.keyId}`,
    '',
    'How to verify this export',
    '',
    '1. The content: the sha256 of report.json must equal "contentHash" in manifest.json and line 4 of signed-message.txt.',
    '     sha256sum report.json            (macOS: shasum -a 256 report.json)',
    '',
    '2. The signature (Ed25519, OpenSSL 3):',
    '     openssl pkeyutl -verify -pubin -inkey public-key.pem -rawin -in signed-message.txt -sigfile signature.bin',
    '   It must print "Signature Verified Successfully".',
    '',
    '3. The key: the key id is the first 16 hex characters of the sha256 of the public key (DER):',
    '     openssl pkey -pubin -in public-key.pem -outform DER | sha256sum | cut -c1-16',
    `   It must equal ${r.keyId}. Compare public-key.pem with the key you pinned from the deployment`,
    '   (GET /v1/audit/keys, or the key published by your OCSO operator) — a bundle can carry any key.',
    '',
    '4. The period and signer: signed-message.txt holds, one per line: "ocso-exception-report", the report id,',
    "   the period (start/end), the content hash, the signer's user id and the signing time. They must match manifest.json.",
    '',
    '5. The attestation and the note: line 7 ("attestation:…") lists what the signer acknowledged — self_attested',
    "   (the signer is named in the report's critical or high items, or approved their own access), failed_checks,",
    '   truncated, incomplete_data — or "none". Line 8 is the sha256 of the sign-off note ("none" without one):',
    '     printf %s "$(jq -r .report.signNote manifest.json)" | sha256sum',
    "   The report's kind (weekly or ad hoc) is inside report.json, so it is covered by the content hash.",
    '',
    `Attestation: ${r.attestation.length ? r.attestation.join(', ') : 'none'}. Key known to the exporting server as: ${r.keyTrust.toLowerCase()}.`,
    '',
    'items.csv is a flat rendering of report.json (one row per item) for spreadsheets; it is not signed on its own.',
    'Regenerate it from report.json, or trust report.json.',
    '',
  ].join('\n');
}

export function exportFileName(r: Pick<ExportableReport, 'kind' | 'periodStart' | 'id'>): string {
  return `ocso-exceptions-${r.kind.toLowerCase()}-${r.periodStart.toISOString().slice(0, 10)}-${r.id.slice(0, 8)}.zip`;
}

export function buildExportBundle(r: ExportableReport, key: AuditPublicKey): Buffer {
  const reportJson = Buffer.from(reportContentBytes(r.content), 'utf8');
  const csv = Buffer.from(itemsCsv(r.content), 'utf8');
  const message = reportSignatureMessage({
    id: r.id,
    period: { start: r.periodStart, end: r.periodEnd },
    contentHash: r.contentHash,
    signedBy: r.signedBy.id,
    signedAt: r.signedAt,
    attestation: r.attestation,
    signNote: r.signNote,
  });
  const manifest = {
    format: EXCEPTION_EXPORT_FORMAT,
    report: {
      id: r.id,
      kind: r.kind,
      periodStart: r.periodStart.toISOString(),
      periodEnd: r.periodEnd.toISOString(),
      timezone: r.content.period.timezone,
      generatedAt: r.generatedAt.toISOString(),
      contentHash: r.contentHash,
      signedBy: r.signedBy,
      signedAt: r.signedAt.toISOString(),
      signNote: r.signNote,
      noteSha256: noteHash(r.signNote),
      attestation: r.attestation,
      keyId: r.keyId,
      keyTrust: r.keyTrust,
      algorithm: 'Ed25519',
      signature: r.signature,
    },
    files: {
      'report.json': sha256Hex(reportJson.toString('utf8')),
      'items.csv': sha256Hex(csv.toString('utf8')),
    },
    totals: r.content.totals,
  };
  return writeZip(
    [
      { name: 'report.json', data: reportJson },
      { name: 'items.csv', data: csv },
      {
        name: 'manifest.json',
        data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
      },
      { name: 'signed-message.txt', data: Buffer.from(message, 'utf8') },
      { name: 'signature.bin', data: Buffer.from(r.signature, 'base64') },
      { name: 'public-key.pem', data: Buffer.from(key.publicKeyPem, 'utf8') },
      { name: 'VERIFY.txt', data: Buffer.from(verifyText(r), 'utf8') },
    ],
    r.signedAt,
  );
}

export interface BundleCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * The verification steps of VERIFY.txt, in code: content hash, signed message,
 * signature, key id (and, when `trusted` is given, that the key is one of them),
 * and that items.csv is exactly what report.json renders to.
 */
export function verifyExportBundle(zip: Buffer, trusted?: readonly AuditPublicKey[]): { ok: boolean; checks: BundleCheck[] } {
  const checks: BundleCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  let files: Map<string, Buffer>;
  try {
    files = readZip(zip);
  } catch (err) {
    return {
      ok: false,
      checks: [{ name: 'bundle', ok: false, detail: (err as Error).message }],
    };
  }
  const text = (n: string) => files.get(n)?.toString('utf8') ?? null;
  const reportJson = text('report.json');
  const manifestText = text('manifest.json');
  const pem = text('public-key.pem');
  const message = text('signed-message.txt');
  const signature = files.get('signature.bin');
  if (!reportJson || !manifestText || !pem || !message || !signature) {
    return {
      ok: false,
      checks: [{ name: 'bundle', ok: false, detail: 'a required file is missing' }],
    };
  }
  type Manifest = {
    report: {
      id: string;
      periodStart: string;
      periodEnd: string;
      contentHash: string;
      signedBy: { id: string };
      signedAt: string;
      keyId: string;
      signature: string;
      signNote?: string | null;
      attestation?: string[];
    };
  };
  let manifest: Manifest;
  try {
    manifest = JSON.parse(manifestText) as Manifest;
    if (!manifest?.report?.id) throw new Error('no report');
  } catch {
    return {
      ok: false,
      checks: [
        {
          name: 'manifest',
          ok: false,
          detail: 'manifest.json is not a report manifest',
        },
      ],
    };
  }
  const m = manifest.report;
  const hash = sha256Hex(reportJson);
  add('content hash', hash === m.contentHash, `sha256(report.json) = ${hash}`);
  let content: ExceptionReportContent | null = null;
  try {
    content = JSON.parse(reportJson) as ExceptionReportContent;
    add('canonical content', reportContentBytes(content) === reportJson, 'report.json is canonical JSON');
  } catch {
    add('canonical content', false, 'report.json is not JSON');
  }
  let expected: string | null = null;
  try {
    expected = reportSignatureMessage({
      id: m.id,
      period: { start: new Date(m.periodStart), end: new Date(m.periodEnd) },
      contentHash: hash,
      signedBy: m.signedBy.id,
      signedAt: new Date(m.signedAt),
      attestation: m.attestation ?? [],
      signNote: m.signNote ?? null,
    });
  } catch {
    expected = null;
  }
  add('signed message', expected === message, 'signed-message.txt matches the manifest (period, signer, attestation, note) and the content hash');
  add('signature', signature.toString('base64') === m.signature && verifySignature(pem, message, m.signature), 'Ed25519 over signed-message.txt with public-key.pem');
  let keyId = '';
  try {
    keyId = keyIdOf(createPublicKey(pem));
  } catch {
    keyId = 'invalid';
  }
  add('key id', keyId === m.keyId, `public-key.pem has key id ${keyId}`);
  if (trusted)
    add(
      'trusted key',
      trusted.some((k) => k.keyId === keyId),
      trusted.length ? `trusted: ${trusted.map((k) => k.keyId).join(', ')}` : 'no trusted keys given',
    );
  if (content) add('items.csv', text('items.csv') === itemsCsv(content), 'items.csv renders report.json exactly');
  return { ok: checks.every((c) => c.ok), checks };
}
