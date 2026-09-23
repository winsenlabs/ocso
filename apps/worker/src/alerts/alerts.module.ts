import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { AlertDeliveryRegistry } from '@ocso/alerts';
import { AlertDeliveryService, AlertEngine, WebhookDeliveryService } from '@ocso/application';
import { createAlertDeliveryRegistry, type OcsoPlugin } from '@ocso/bootstrap';
import type { WorkerEnv } from '@ocso/config';
import type { Db } from '@ocso/db';
import type { EmailSender } from '@ocso/email';
import { createGuardedFetch, type GuardedFetch } from '@ocso/mcp';
import { ocsoMetrics } from '@ocso/observability';
import type { QueueAdapter } from '@ocso/queue';
import type { SecretStore } from '@ocso/secrets';
import { DB, EMAIL_SENDER, ENV, PLUGINS, QUEUE, SECRET_STORE } from '../infrastructure/tokens.js';

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
      provide: AlertDeliveryRegistry,
      inject: [AlertEgress, EMAIL_SENDER, PLUGINS],
      // Every plugin's alert destinations (composition root).
      useFactory: (egress: AlertEgress, emailSender: EmailSender, plugins: readonly OcsoPlugin[]) =>
        createAlertDeliveryRegistry({ fetch: egress.guarded.fetch, emailSender }, plugins),
    },
    {
      provide: AlertEngine,
      inject: [DB, QUEUE, AlertDeliveryRegistry],
      useFactory: (db: Db, queue: QueueAdapter, registry: AlertDeliveryRegistry) =>
        new AlertEngine({
          db,
          queue,
          // Adapters declare which lifecycle events they receive.
          destinations: registry,
          // A queue kept in PostgreSQL is read directly (jobs table); any other driver answers through its stats.
          queueStats: queue.inDatabase ? undefined : (topic) => queue.stats(topic),
          metrics: { alertOpened: (labels) => ocsoMetrics().alertsOpened.add(1, labels) },
        }),
    },
    {
      provide: AlertDeliveryService,
      inject: [DB, SECRET_STORE, ENV, AlertDeliveryRegistry],
      useFactory: (db: Db, secrets: SecretStore, env: WorkerEnv, registry: AlertDeliveryRegistry) =>
        new AlertDeliveryService({
          db,
          secrets,
          registry,
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
