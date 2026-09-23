import { Logger, Module } from '@nestjs/common';
import { AgentAnalyticsService, ExceptionService, HOME_CACHE_MS, HomeService, QueueAnalyticsService, scopeContent, type ApprovalRegistry, type ExceptionReportContent } from '@ocso/application';
import type { Db } from '@ocso/db';
import type { QueueAdapter } from '@ocso/queue';
import { DB, QUEUE } from '../../infrastructure/tokens.js';
import { APPROVAL_REGISTRY } from '../approvals/approvals.tokens.js';
import { AnalyticsController } from './analytics.controller.js';
import { HomeController } from './home.controller.js';

/** Lead analytics, queue analytics and the role-aware home (docs/11 §3–4, design/02, design/06). */
@Module({
  controllers: [AnalyticsController, HomeController],
  providers: [
    { provide: AgentAnalyticsService, inject: [DB], useFactory: (db: Db) => new AgentAnalyticsService(db) },
    { provide: QueueAnalyticsService, inject: [DB], useFactory: (db: Db) => new QueueAnalyticsService(db) },
    {
      // Home reads approvals through the registry (which check permission decides each kind) and the exception
      // report's live view (scoped per reader); ApprovalsModule is global, so the registry is always here.
      provide: HomeService,
      inject: [DB, QUEUE, APPROVAL_REGISTRY],
      useFactory: (db: Db, queue: QueueAdapter, registry: ApprovalRegistry) => {
        const logger = new Logger('Home');
        const exceptions = new ExceptionService(db, registry, { log: (message, err) => logger.warn(`${message}: ${err instanceof Error ? err.message : String(err)}`) });
        // Every check of the live report runs once per cache period for all readers; each reader gets their own scope of it.
        let live: { expires: number; content: Promise<ExceptionReportContent> } | null = null;
        const liveContent = () => {
          if (!live || live.expires <= Date.now()) {
            const content = exceptions.liveContent();
            live = { expires: Date.now() + HOME_CACHE_MS, content };
            content.catch(() => {
              if (live?.content === content) live = null;
            });
          }
          return live.content;
        };
        return new HomeService(db, {
          queueStats: (topic) => queue.stats(topic),
          registry,
          liveExceptions: async (principal) => scopeContent(await liveContent(), principal),
          onError: (source, err) => logger.warn(`home: ${source} failed: ${err instanceof Error ? err.message : String(err)}`),
        });
      },
    },
  ],
  exports: [AgentAnalyticsService, QueueAnalyticsService, HomeService],
})
export class AnalyticsModule {}
