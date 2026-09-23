import { canonicalJson, sha256Hex, verifySignature, type AuditPublicKey } from '@ocso/audit-store';
import type { ExceptionReportContent } from './contract.js';
import { periodText, type Period } from './periods.js';

/**
 * Exception report signatures (PM/research/11 §7, ADR-033). The content hash is
 * sha256 (hex) of the canonical JSON of the report content — exactly the bytes
 * of `report.json` in an export. The signature is Ed25519 with the audit signing
 * key (the key that signs audit checkpoints) over:
 *
 *   ocso-exception-report\n<id>\n<periodStart ISO>/<periodEnd ISO>\n<content_hash>\n<signed_by user id>\n<signed_at ISO>
 *   \nattestation:<flags, comma-separated, or none>\nnote-sha256:<sha256 hex of the sign-off note, or none>
 *
 * The first six lines are the spec's (PM/research/11 §7). The last two bind the signer's attestation: what
 * they acknowledged when signing (self-attested, failed or incomplete checks, truncated sections) and the
 * exact note they wrote, so neither can be edited in an export. The report's kind is inside the content.
 */

export const REPORT_MESSAGE_PREFIX = 'ocso-exception-report';

export function reportContentBytes(content: ExceptionReportContent | Record<string, unknown>): string {
  return canonicalJson(content);
}

export function reportContentHash(content: ExceptionReportContent | Record<string, unknown>): string {
  return sha256Hex(reportContentBytes(content));
}

export interface SignedFields {
  id: string;
  period: Period;
  contentHash: string;
  signedBy: string;
  signedAt: Date;
  /** Acknowledged attestation flags (sorted when signed). */
  attestation: readonly string[];
  signNote: string | null;
}

export function noteHash(note: string | null): string {
  return note ? sha256Hex(note) : 'none';
}

export function reportSignatureMessage(f: SignedFields): string {
  const flags = f.attestation.length ? [...f.attestation].sort().join(',') : 'none';
  return `${REPORT_MESSAGE_PREFIX}\n${f.id}\n${periodText(f.period)}\n${f.contentHash}\n${f.signedBy}\n${f.signedAt.toISOString()}\nattestation:${flags}\nnote-sha256:${noteHash(f.signNote)}`;
}

export type ReportSignatureCheck = 'VALID' | 'INVALID' | 'UNKNOWN_KEY' | 'CONTENT_CHANGED';

/**
 * Checks a signed report: the content still hashes to the signed hash, and the
 * signature verifies with the key it names among the trusted keys.
 */
export function verifyReportSignature(
  report: SignedFields & { content: ExceptionReportContent | Record<string, unknown>; keyId: string; signature: string },
  keys: readonly AuditPublicKey[],
): ReportSignatureCheck {
  if (reportContentHash(report.content) !== report.contentHash) return 'CONTENT_CHANGED';
  const key = keys.find((k) => k.keyId === report.keyId);
  if (!key) return 'UNKNOWN_KEY';
  return verifySignature(key.publicKeyPem, reportSignatureMessage(report), report.signature) ? 'VALID' : 'INVALID';
}
