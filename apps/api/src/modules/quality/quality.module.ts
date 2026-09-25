import { Module } from '@nestjs/common';
import { CorrectionService, CsatService, EvaluationRunService, ReviewService } from '@ocso/application';
import type { Db } from '@ocso/db';
import type { QueueAdapter } from '@ocso/queue';
import { DB, QUEUE } from '../../infrastructure/tokens.js';
import { WebChatIdentityService } from '../webchat/webchat-identity.service.js';
import { CorrectionsController } from './corrections.controller.js';
import { ConversationCsatController, WebChatCsatController } from './csat.controller.js';
import { EvaluationsController } from './evaluations.controller.js';
import { ReviewsController } from './reviews.controller.js';

/**
 * Quality loop (docs/archive/specs/09 §7, docs/archive/specs/11 §3): reviews, prompt corrections, CSAT and
 * replay evaluations. WebChatIdentityService needs ChannelRuntime, provided by
 * the global ChannelsModule.
 */
@Module({
  controllers: [ReviewsController, CorrectionsController, EvaluationsController, ConversationCsatController, WebChatCsatController],
  providers: [
    WebChatIdentityService,
    { provide: ReviewService, inject: [DB], useFactory: (db: Db) => new ReviewService(db) },
    { provide: CorrectionService, inject: [DB], useFactory: (db: Db) => new CorrectionService(db) },
    { provide: CsatService, inject: [DB], useFactory: (db: Db) => new CsatService(db) },
    { provide: EvaluationRunService, inject: [DB, QUEUE], useFactory: (db: Db, queue: QueueAdapter) => new EvaluationRunService(db, queue) },
  ],
  exports: [ReviewService, CorrectionService, CsatService, EvaluationRunService],
})
export class QualityModule {}
