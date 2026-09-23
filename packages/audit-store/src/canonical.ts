import { createHash } from 'node:crypto';
import type { AuditRecord } from './contract.js';

/** prevHash of chain position 1. */
export const GENESIS_HASH = '0'.repeat(64);

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Canonical JSON (RFC 8785-style): object keys sorted by UTF-16 code units,
 * no whitespace, `undefined` members dropped, Dates as ISO strings. Arrays keep
 * their order. Non-finite numbers are refused (JSON cannot carry them).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'bigint':
      return value.toString();
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported ${typeof value}`);
  }
}

/** The exact field set that is hashed; absent payloads are null so a round trip cannot change the hash. */
export function canonicalRecord(r: AuditRecord): Record<string, unknown> {
  return {
    id: r.id,
    occurredAt: r.occurredAt.toISOString(),
    actorType: r.actorType,
    actorId: r.actorId,
    actorName: r.actorName,
    via: r.via,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    summary: r.summary,
    before: r.before ?? null,
    after: r.after ?? null,
    correlationId: r.correlationId,
    confirmation: r.confirmation ?? null,
    ip: r.ip,
    teamIds: [...r.teamIds],
  };
}

/** sha256 of the record's canonical JSON, lower-case hex. */
export const recordHash = (r: AuditRecord): string => sha256Hex(canonicalJson(canonicalRecord(r)));

/** sha256 over the two 64-character hex strings concatenated (prev first). */
export const chainHash = (prevHash: string, recHash: string): string => sha256Hex(`${prevHash}${recHash}`);

export const HASH_PATTERN = /^[0-9a-f]{64}$/;
