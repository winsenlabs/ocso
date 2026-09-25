import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { desc } from 'drizzle-orm';
import { canonicalJson, publicKeyOf, type AuditSigner, type AuditStore, type Checkpoint } from '@ocso/audit-store';
import { auditExports, uuidv7, type Db } from '@ocso/db';
import { recordAuditIncident, resolveAuditIncidents } from './incidents.js';
import { storeError } from './shipping.js';

/** The only BlobStore capability exports need. */
export interface ExportBlobs {
  put(input: { key: string; data: Uint8Array; contentType: string; retention?: 'EXPORT' | undefined }): Promise<unknown>;
}

export type AuditExport = typeof auditExports.$inferSelect;

export const EXPORT_FORMAT = 'ocso-audit-export/1';

/** The signed text of an export manifest: the canonical JSON of every manifest field but `signature`. */
export const exportManifestMessage = (manifest: Record<string, unknown>): string => `ocso-audit-export\n${canonicalJson({ ...manifest, signature: undefined })}`;

export interface ExportOptions {
  /** Entries per export file (the range ends at a checkpoint at or before from + maxEntries − 1 when one exists). */
  maxEntries?: number;
  /** Minimum time between exports. */
  everyMs?: number;
  now?: () => Date;
}

/**
 * audit-export (PM/research/11 §6.3): the sealed range since the last export,
 * up to a signed checkpoint, written to the BlobStore as
 * `audit-exports/YYYY/MM/DD/<from>-<to>.ndjson.gz` (one line per chain entry
 * with its record) plus `<from>-<to>.manifest.json` — the checkpoint, the
 * public key, the file's sha256 and an Ed25519 signature over the manifest.
 * An auditor checks an export offline against a public key they pinned
 * independently (GET /v1/audit/keys, or their own records) — never the key the
 * manifest carries, which a forger would simply replace. Exports are only an
 * independent copy when the BlobStore enforces write-once retention on
 * `audit-exports/` (S3 Object Lock; docs/archive/specs/15 §7). When no newer signed
 * checkpoint exists for two export periods, EXPORT_FAILED says exports are
 * blocked.
 */
export class AuditExporter {
  constructor(
    private readonly db: Db,
    private readonly store: AuditStore,
    private readonly blobs: ExportBlobs,
    private readonly signer: AuditSigner | null,
    private readonly options: ExportOptions = {},
  ) {}

  async exportDue(): Promise<AuditExport | null> {
    if (!this.signer) return null;
    const now = this.options.now?.() ?? new Date();
    const [last] = await this.db.select().from(auditExports).orderBy(desc(auditExports.toPosition)).limit(1);
    if (last && now.getTime() - last.createdAt.getTime() < (this.options.everyMs ?? 24 * 3600 * 1000)) return null;
    const every = this.options.everyMs ?? 24 * 3600 * 1000;
    const from = (last?.toPosition ?? 0) + 1;
    try {
      const done = await this.exportFrom(from, this.signer, now);
      if (done) await resolveAuditIncidents(this.db, ['EXPORT_FAILED']);
      else await this.checkBlocked(from, last?.createdAt ?? null, now, every);
      return done;
    } catch (err) {
      await recordAuditIncident(this.db, 'EXPORT_FAILED', { driver: this.store.driver, error: storeError(err) });
      throw err;
    }
  }

  private async exportFrom(from: number, signer: AuditSigner, now: Date): Promise<AuditExport | null> {
    const max = this.options.maxEntries ?? 100_000;
    const checkpoint = await this.endCheckpoint(from, from + max - 1);
    if (!checkpoint) return null;
    const to = checkpoint.upToPosition;
    const lines: string[] = [];
    let records = 0;
    for (let at = from; at <= to; ) {
      const page = await this.store.chainRange(at, Math.min(1000, to - at + 1));
      if (!page.length || page[0]!.entry.position !== at) throw new Error(`audit chain entry ${at} is missing`);
      for (const { entry, record } of page) {
        if (entry.position > to) break;
        if (record) records++;
        lines.push(canonicalJson({ entry, record }));
        at = entry.position + 1;
      }
    }
    const data = gzipSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8'));
    const sha256 = createHash('sha256').update(data).digest('hex');
    const day = now.toISOString().slice(0, 10).replace(/-/g, '/');
    const blobKey = `audit-exports/${day}/${from}-${to}.ndjson.gz`;
    const manifestKey = `audit-exports/${day}/${from}-${to}.manifest.json`;
    const manifest: Record<string, unknown> = {
      format: EXPORT_FORMAT,
      driver: this.store.driver,
      from,
      to,
      entries: lines.length,
      records,
      file: blobKey,
      sha256,
      checkpoint,
      publicKey: publicKeyOf(signer),
      createdAt: now.toISOString(),
    };
    manifest['signature'] = signer.sign(exportManifestMessage(manifest));
    await this.blobs.put({ key: blobKey, data, contentType: 'application/gzip', retention: 'EXPORT' });
    await this.blobs.put({ key: manifestKey, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), contentType: 'application/json', retention: 'EXPORT' });
    const [row] = await this.db
      .insert(auditExports)
      .values({ id: uuidv7(), fromPosition: from, toPosition: to, records, blobKey, manifestKey, sha256, checkpointId: checkpoint.id, keyId: signer.keyId, createdAt: now })
      .returning();
    return row!;
  }

  /** Sealed entries wait beyond `from`, but no checkpoint signed by this key covers them for two periods: say so. */
  private async checkBlocked(from: number, lastExportAt: Date | null, now: Date, every: number): Promise<void> {
    const head = await this.store.chainHead();
    if (!head || head.position < from) return;
    const since = lastExportAt ?? (await this.store.chainRange(from, 1))[0]?.entry.sealedAt ?? now;
    if (now.getTime() - since.getTime() < 2 * every) return;
    await recordAuditIncident(this.db, 'EXPORT_FAILED', {
      driver: this.store.driver,
      error: `no checkpoint signed by key ${this.signer?.keyId ?? '?'} beyond position ${from - 1}; ${head.position - from + 1} sealed entries wait to be exported (see CHAIN_BROKEN / SIGNING_KEY_CHANGED)`,
      blockedSince: since.toISOString(),
    });
  }

  /** The highest checkpoint in [from, maxTo], else the first one after `from` (a long range), else none yet. */
  private async endCheckpoint(from: number, maxTo: number): Promise<Checkpoint | null> {
    const keyId = this.signer?.keyId;
    const own = (cs: Checkpoint[]) => cs.filter((c) => c.keyId === keyId);
    const [within] = own(await this.store.checkpoints({ fromPosition: from, toPosition: maxTo, limit: 20 }));
    if (within) return within;
    const later = own(await this.store.checkpoints({ fromPosition: from, limit: 10_000 }));
    return later[later.length - 1] ?? null;
  }
}
