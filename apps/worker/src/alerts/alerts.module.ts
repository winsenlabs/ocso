import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { createDefaultDeliveryRegistry } from '@ocso/alerts';
import { AlertDeliveryService, AlertEngine, WebhookDeliveryService } from '@ocso/application';
import type { WorkerEnv } from '@ocso/config';
import type { Db } from '@ocso/db';
import type { EmailSender } from '@ocso/email';
import { createGuardedFetch, type GuardedFetch } from '@ocso/mcp';
import { ocsoMetrics } from '@ocso/observability';
import type { QueueAdapter } from '@ocso/queue';
import type { SecretStore } from '@ocso/secrets';
import { DB, EMAIL_SENDER, ENV, QUEUE, SECRET_STORE } from '../infrastructure/tokens.js';

/** Attempts before a transient delivery failure is final; ≤ the consumer's maxAttempts. */
export const ALERT_DELIVERY_ATTEMPTS = 6;
export const WEBHOOK_DELIVERY_ATTEMPTS = 8;

/** Alert destinations are external: public https only, through the SSRF guard. */
@Injectable()
export class AlertEgress implements OnModuleDestroy {
  readonly guarded: GuardedFetch = createGuardedFetch({ policy: { allowedInternalHosts: [], allowInsecureHttpHosts: [] }, network: 'PUBLIC' });

  onModuleDestroy(): void {
    this.guarded.close();
  }
}

/** Alert evaluation + delivery and outbound event webhook delivery (docs/11 §6, E8.10). */
@Module({
  providers: [
    AlertEgress,
    {
      provide: AlertEngine,
      inject: [DB, QUEUE, ENV],
      useFactory: (db: Db, queue: QueueAdapter, env: WorkerEnv) =>
        new AlertEngine({
          db,
          queue,
          // Postgres mode reads the jobs table directly; SQS mode needs driver stats.
          queueStats: env.QUEUE_DRIVER === 'sqs' ? (topic) => queue.stats(topic) : undefined,
          metrics: { alertOpened: (labels) => ocsoMetrics().alertsOpened.add(1, labels) },
        }),
    },
    {
      provide: AlertDeliveryService,
      inject: [DB, SECRET_STORE, ENV, AlertEgress, EMAIL_SENDER],
      useFactory: (db: Db, secrets: SecretStore, env: WorkerEnv, egress: AlertEgress, emailSender: EmailSender) =>
        new AlertDeliveryService({
          db,
          secrets,
          registry: createDefaultDeliveryRegistry({ fetch: egress.guarded.fetch, emailSender }),
          baseUrl: env.OCSO_PUBLIC_URL,
          maxAttempts: ALERT_DELIVERY_ATTEMPTS,
        }),
    },
    {
      provide: WebhookDeliveryService,
      inject: [DB, SECRET_STORE, AlertEgress],
      useFactory: (db: Db, secrets: SecretStore, egress: AlertEgress) =>
        new WebhookDeliveryService({ db, secrets, fetch: egress.guarded.fetch, maxAttempts: WEBHOOK_DELIVERY_ATTEMPTS }),
    },
  ],
  exports: [AlertEngine, AlertDeliveryService, WebhookDeliveryService],
})
export class WorkerAlertsModule {}
