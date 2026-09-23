import { Module } from '@nestjs/common';
import { AgentAnalyticsService, HomeService, QueueAnalyticsService } from '@ocso/application';
import type { Db } from '@ocso/db';
import type { QueueAdapter } from '@ocso/queue';
import { DB, QUEUE } from '../../infrastructure/tokens.js';
import { AnalyticsController } from './analytics.controller.js';
import { HomeController } from './home.controller.js';

/** Lead analytics, queue analytics and the role-aware home (docs/11 §3–4, design/02, design/06). */
@Module({
  controllers: [AnalyticsController, HomeController],
  providers: [
    { provide: AgentAnalyticsService, inject: [DB], useFactory: (db: Db) => new AgentAnalyticsService(db) },
    { provide: QueueAnalyticsService, inject: [DB], useFactory: (db: Db) => new QueueAnalyticsService(db) },
    {
      provide: HomeService,
      inject: [DB, QUEUE],
      useFactory: (db: Db, queue: QueueAdapter) => new HomeService(db, { queueStats: (topic) => queue.stats(topic) }),
    },
  ],
  exports: [AgentAnalyticsService, QueueAnalyticsService, HomeService],
})
export class AnalyticsModule {}
