import { Module } from '@nestjs/common';
import { SystemOverviewService } from '@ocso/application';
import type { ApiEnv } from '@ocso/config';
import type { Db } from '@ocso/db';
import type { QueueAdapter } from '@ocso/queue';
import { DB, ENV, QUEUE } from '../../infrastructure/tokens.js';
import { TelemetryController } from './telemetry.controller.js';

/**
 * Tech Admin telemetry (docs/11 §2). Trace links use OCSO_TRACE_URL_TEMPLATE
 * (e.g. `http://localhost:16686/trace/{traceId}`); queue depth comes from the
 * configured queue adapter so SQS deployments report real depth.
 */
@Module({
  controllers: [TelemetryController],
  providers: [
    {
      provide: SystemOverviewService,
      inject: [DB, QUEUE, ENV],
      useFactory: (db: Db, queue: QueueAdapter, env: ApiEnv) =>
        new SystemOverviewService(db, {
          traceUrlTemplate: env.OCSO_TRACE_URL_TEMPLATE ?? null,
          apiVersion: env.APP_VERSION,
          queueStats: (topic) => queue.stats(topic),
        }),
    },
  ],
  exports: [SystemOverviewService],
})
export class TelemetryModule {}
