import { Logger, Module } from '@nestjs/common';
import { ExceptionService, type ApprovalRegistry, type AuditSigner } from '@ocso/application';
import type { Db } from '@ocso/db';
import { AUDIT_SIGNER, DB } from '../../infrastructure/tokens.js';
import { APPROVAL_REGISTRY } from '../approvals/approvals.tokens.js';
import { ExceptionsController } from './exceptions.controller.js';
import { StorageController } from './storage.controller.js';

/** Exceptions and storage (PM/research/11 §7): the report's live view, weekly reports, signing, exports; GET /v1/system/storage. */
@Module({
  controllers: [ExceptionsController, StorageController],
  providers: [
    {
      provide: ExceptionService,
      inject: [DB, APPROVAL_REGISTRY, AUDIT_SIGNER],
      useFactory: (db: Db, registry: ApprovalRegistry, signer: AuditSigner) => {
        const logger = new Logger('Exceptions');
        return new ExceptionService(db, registry, { signer, log: (message, err) => logger.warn(`${message}: ${err instanceof Error ? err.message : String(err)}`) });
      },
    },
  ],
})
export class ExceptionsModule {}
