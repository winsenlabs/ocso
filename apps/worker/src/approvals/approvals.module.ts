import { Inject, Injectable, Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ApprovalDecisionService,
  ApprovalNotifier,
  createApprovalRegistry,
  redispatchActivations,
  redispatchApprovalNotices,
  revalidateCheckers,
  systemActor,
  voidOrphanProposals,
  type ApprovalNotifyJob,
  type ApprovalRegistry,
} from '@ocso/application';
import type { WorkerEnv } from '@ocso/config';
import type { Db } from '@ocso/db';
import { EmailSendError, type EmailSender } from '@ocso/email';
import type { Logger } from '@ocso/observability';
import { TOPICS, backoffSeconds, type HandlerResult, type QueueAdapter, type QueueSubscription } from '@ocso/queue';
import { DB, EMAIL_SENDER, ENV, LOGGER, QUEUE } from '../infrastructure/tokens.js';
import type { ScheduledTask } from '../scheduler/scheduler.service.js';

/** The approval registry (`ApprovalRegistry`), built by the same composition point as the API's. */
export const APPROVAL_REGISTRY = Symbol('APPROVAL_REGISTRY');

/**
 * Maker–checker background work (PM/research/11b): approval emails
 * (approval.notify), deferred activations (approval.activate) and the leader
 * sweeps — checker validity (never reassigns), notice and activation
 * redispatch, orphan voiding.
 */
@Injectable()
export class ApprovalsWorker {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APPROVAL_REGISTRY) private readonly registry: ApprovalRegistry,
    @Inject(ApprovalDecisionService) private readonly decisions: ApprovalDecisionService,
    @Inject(ApprovalNotifier) private readonly notifier: ApprovalNotifier,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  consume(queue: QueueAdapter): QueueSubscription[] {
    return [
      queue.consume<ApprovalNotifyJob>(
        TOPICS.APPROVAL_NOTIFY,
        async (m): Promise<HandlerResult> => {
          try {
            await this.notifier.handle(m.payload);
            return { kind: 'ack' };
          } catch (err) {
            if (err instanceof EmailSendError && !err.retriable) {
              this.logger.warn({ err, proposalId: m.payload.proposalId }, 'approval email refused');
              return { kind: 'ack' };
            }
            return { kind: 'retry', delaySeconds: backoffSeconds(m.attempt, 5), reason: 'approval email' };
          }
        },
        { concurrency: 4, visibilityTimeoutSeconds: 60, maxAttempts: 5 },
      ),
      queue.consume<{ proposalId: string }>(
        TOPICS.APPROVAL_ACTIVATE,
        async (m): Promise<HandlerResult> => {
          const outcome = await this.decisions.finishActivation(systemActor('approval-activation', randomUUID(), 'Approval activation'), m.payload.proposalId);
          this.logger.info({ proposalId: m.payload.proposalId, outcome }, 'deferred approval activation');
          return { kind: 'ack' };
        },
        { concurrency: 2, visibilityTimeoutSeconds: 120, maxAttempts: 5 },
      ),
    ];
  }

  tasks(): ScheduledTask[] {
    const actor = (name: string) => systemActor(name, randomUUID(), 'Approval sweep');
    return [
      { name: 'approval-checker-sweep', everySeconds: 300, run: ({ queue }) => revalidateCheckers(this.db, this.registry, queue, actor('approval-checker-sweep'), this.logger) },
      { name: 'approval-notify-redispatch', everySeconds: 300, run: ({ queue }) => redispatchApprovalNotices(this.db, queue, new Date(), this.logger) },
      { name: 'approval-activate-redispatch', everySeconds: 300, run: ({ queue }) => redispatchActivations(this.db, queue, new Date(), this.logger) },
      { name: 'approval-void-orphans', everySeconds: 900, run: () => voidOrphanProposals(this.db, this.registry, actor('approval-void-orphans')) },
    ];
  }
}

@Module({
  providers: [
    { provide: APPROVAL_REGISTRY, useFactory: () => createApprovalRegistry() },
    {
      provide: ApprovalDecisionService,
      inject: [DB, APPROVAL_REGISTRY, QUEUE, LOGGER],
      useFactory: (db: Db, registry: ApprovalRegistry, queue: QueueAdapter, logger: Logger) => new ApprovalDecisionService(db, registry, { queue, logger }),
    },
    {
      provide: ApprovalNotifier,
      inject: [DB, APPROVAL_REGISTRY, EMAIL_SENDER, ENV],
      useFactory: (db: Db, registry: ApprovalRegistry, email: EmailSender, env: WorkerEnv) => new ApprovalNotifier({ db, registry, email, baseUrl: env.OCSO_PUBLIC_URL }),
    },
    ApprovalsWorker,
  ],
  exports: [ApprovalsWorker],
})
export class WorkerApprovalsModule {}
