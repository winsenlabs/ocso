import { Inject, Injectable, Module } from '@nestjs/common';
import { AuditExporter, AuditFullVerifier, AuditSealer, AuditShipper, reconcileAudit, withTimeout, type AuditSigner, type AuditStore } from '@ocso/application';
import type { BlobStore } from '@ocso/blob';
import type { Db } from '@ocso/db';
import type { Logger } from '@ocso/observability';
import { AUDIT_SIGNER, AUDIT_STORE, BLOB_STORE, DB, LOGGER } from '../infrastructure/tokens.js';
import type { ScheduledTask } from '../scheduler/scheduler.service.js';

/** No audit task may hold the leader's sequential tick longer than this (store calls are bounded too). */
const TASK_DEADLINE_MS = 60_000;

/**
 * The audit store's leader tasks (PM/research/11 §6.3, ADR-032): ship the
 * outbox (2 s), reconcile what the store holds (5 min), seal the hash chain
 * and sign checkpoints (10 s), export signed ranges to the BlobStore (checked
 * hourly, one export a day) and re-verify the whole chain in pages (checked
 * every minute, one full pass a day). Every task is idempotent and bounded by a
 * deadline; while the shipper backs off from a failing store the others skip
 * their store work, so a store outage delays only the audit tasks (incidents
 * record it), never the rest of the leader's work or OCSO itself.
 */
@Injectable()
export class AuditWorker {
  private readonly shipper: AuditShipper;
  private readonly sealer: AuditSealer;
  private readonly exporter: AuditExporter;
  private readonly verifier: AuditFullVerifier;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUDIT_STORE) readonly store: AuditStore,
    @Inject(AUDIT_SIGNER) signer: AuditSigner,
    @Inject(BLOB_STORE) blobs: BlobStore,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.shipper = new AuditShipper(db, store, { logger: { warn: (fields, msg) => logger.warn(fields, msg) } });
    this.sealer = new AuditSealer(db, store, signer);
    this.exporter = new AuditExporter(db, store, blobs, signer);
    this.verifier = new AuditFullVerifier(db, store, signer);
  }

  tasks(): ScheduledTask[] {
    return [
      this.task('audit-ship', 2, () => this.shipper.ship(), false),
      this.task('audit-reconcile', 300, () => reconcileAudit(this.db, this.store)),
      this.task('audit-seal', 10, () => this.sealer.seal()),
      this.task('audit-export', 3600, () => this.exporter.exportDue()),
      this.task('audit-verify-full', 60, () => this.verifier.run()),
    ];
  }

  /** The store is failing (the shipper backs off): store-heavy tasks wait for it to recover. */
  get storeBackingOff(): boolean {
    return this.shipper.backingOff();
  }

  private task(name: string, everySeconds: number, run: () => Promise<unknown>, skipWhileBackingOff = true): ScheduledTask {
    return {
      name,
      everySeconds,
      run: async () => {
        if (skipWhileBackingOff && this.shipper.backingOff()) return { skipped: 'audit store backing off' };
        return withTimeout(run(), TASK_DEADLINE_MS, `${name}`);
      },
    };
  }
}

@Module({ providers: [AuditWorker], exports: [AuditWorker] })
export class WorkerAuditModule {}
