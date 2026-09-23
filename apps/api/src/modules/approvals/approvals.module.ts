import { Global, Logger, Module } from '@nestjs/common';
import { ApprovalDecisionService, ApprovalService, createApprovalRegistry, type ApprovalLogger, type ApprovalRegistry, type PlatformApprovalDeps } from '@ocso/application';
import type { Db } from '@ocso/db';
import type { QueueAdapter } from '@ocso/queue';
import { DB, QUEUE } from '../../infrastructure/tokens.js';
import { ApprovalsController } from './approvals.controller.js';
import { APPROVAL_REGISTRY } from './approvals.tokens.js';
import { PLATFORM_APPROVAL_DEPS, platformApprovalDepsProvider } from '../settings/platform-approval-deps.js';

const nest = new Logger('Approvals');
/** A failed queue publish is reported, never swallowed (the leader's redispatch sweeps retry it). */
const logger: ApprovalLogger = { warn: (context, message) => nest.warn(`${message} ${JSON.stringify({ ...context, err: String(context['err']) })}`) };

/**
 * Maker–checker (PM/research/11 §4, 11b). Global so every module with
 * approvable writes injects ApprovalService (requestApproval) without an
 * import; the registry comes from the one composition point the worker uses too.
 */
@Global()
@Module({
  controllers: [ApprovalsController],
  providers: [
    platformApprovalDepsProvider,
    { provide: APPROVAL_REGISTRY, inject: [PLATFORM_APPROVAL_DEPS], useFactory: (platform: PlatformApprovalDeps) => createApprovalRegistry({ platform }) },
    {
      provide: ApprovalService,
      inject: [DB, APPROVAL_REGISTRY, QUEUE],
      useFactory: (db: Db, registry: ApprovalRegistry, queue: QueueAdapter) => new ApprovalService(db, registry, { queue, logger }),
    },
    {
      provide: ApprovalDecisionService,
      inject: [DB, APPROVAL_REGISTRY, QUEUE],
      useFactory: (db: Db, registry: ApprovalRegistry, queue: QueueAdapter) => new ApprovalDecisionService(db, registry, { queue, logger }),
    },
  ],
  exports: [APPROVAL_REGISTRY, ApprovalService, ApprovalDecisionService],
})
export class ApprovalsModule {}
