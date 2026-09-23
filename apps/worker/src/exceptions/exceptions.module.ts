import { Inject, Injectable, Module } from '@nestjs/common';
import { ExceptionService, rollupHealthSamples, sampleStorage, type ApprovalRegistry, type AuditStore } from '@ocso/application';
import type { Db } from '@ocso/db';
import type { Logger } from '@ocso/observability';
import { APPROVAL_REGISTRY, WorkerApprovalsModule } from '../approvals/approvals.module.js';
import { AUDIT_STORE, DB, LOGGER } from '../infrastructure/tokens.js';
import type { ScheduledTask } from '../scheduler/scheduler.service.js';

/**
 * Exceptions and storage leader tasks (PM/research/11 §7, ADR-033): freeze
 * every complete weekly period not yet frozen, once setup is complete (checked
 * every minute; chained and idempotent, announced by `exception_report.ready`), sample table sizes (hourly,
 * one row per table and day) and roll health samples up by the hour (raw kept two days).
 */
@Injectable()
export class ExceptionsWorker {
  private readonly exceptions: ExceptionService;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APPROVAL_REGISTRY) registry: ApprovalRegistry,
    @Inject(AUDIT_STORE) private readonly store: AuditStore,
    @Inject(LOGGER) logger: Logger,
  ) {
    // The worker never signs: reports are signed by a person in the api.
    this.exceptions = new ExceptionService(db, registry, { log: (message, err) => logger.warn({ err }, message) });
  }

  tasks(): ScheduledTask[] {
    return [
      // Cheap when there is nothing to freeze (two reads); a minute keeps the first report close to setup.
      { name: 'exception-weekly', everySeconds: 60, run: ({ correlationId }) => this.exceptions.generateWeekly(correlationId) },
      { name: 'storage-sample', everySeconds: 3600, run: () => sampleStorage(this.db, this.store) },
      { name: 'health-rollup', everySeconds: 300, run: () => rollupHealthSamples(this.db) },
    ];
  }
}

@Module({ imports: [WorkerApprovalsModule], providers: [ExceptionsWorker], exports: [ExceptionsWorker] })
export class WorkerExceptionsModule {}
