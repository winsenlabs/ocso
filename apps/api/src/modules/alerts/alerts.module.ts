import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { AlertDeliveryRegistry } from '@ocso/alerts';
import { AlertRuleService, AlertService, NotificationDestinationService } from '@ocso/application';
import { createAlertDeliveryRegistry, type OcsoPlugin } from '@ocso/bootstrap';
import type { ApiEnv } from '@ocso/config';
import type { Db } from '@ocso/db';
import type { EmailSender } from '@ocso/email';
import { createGuardedFetch, type GuardedFetch } from '@ocso/mcp';
import type { QueueAdapter } from '@ocso/queue';
import type { SecretStore } from '@ocso/secrets';
import { DB, EMAIL_SENDER, ENV, PLUGINS, QUEUE, SECRET_STORE } from '../../infrastructure/tokens.js';
import { AlertRulesController } from './alert-rules.controller.js';
import { AlertsController } from './alerts.controller.js';
import { NotificationDestinationsController } from './notification-destinations.controller.js';

/**
 * SSRF-guarded egress for admin-entered destination URLs (test sends from the
 * API). Public hosts over https only; keep-alive sockets closed on shutdown.
 */
@Injectable()
export class AlertEgress implements OnModuleDestroy {
  readonly guarded: GuardedFetch = createGuardedFetch({ policy: { allowedInternalHosts: [], allowInsecureHttpHosts: [] }, network: 'PUBLIC' });

  onModuleDestroy(): void {
    this.guarded.close();
  }
}

@Module({
  controllers: [AlertsController, AlertRulesController, NotificationDestinationsController],
  providers: [
    AlertEgress,
    {
      provide: AlertDeliveryRegistry,
      inject: [AlertEgress, EMAIL_SENDER, PLUGINS],
      // Every plugin's alert destinations (composition root). EMAIL destinations default to the deployment sender (EMAIL_DRIVER).
      useFactory: (egress: AlertEgress, emailSender: EmailSender, plugins: readonly OcsoPlugin[]) =>
        createAlertDeliveryRegistry({ fetch: egress.guarded.fetch, emailSender }, plugins),
    },
    // Acknowledge / resolve / rule deletion notify only destinations whose adapter receives that event.
    {
      provide: AlertService,
      inject: [DB, QUEUE, AlertDeliveryRegistry],
      useFactory: (db: Db, queue: QueueAdapter, registry: AlertDeliveryRegistry) => new AlertService(db, queue, registry),
    },
    {
      provide: AlertRuleService,
      inject: [DB, QUEUE, AlertDeliveryRegistry],
      useFactory: (db: Db, queue: QueueAdapter, registry: AlertDeliveryRegistry) => new AlertRuleService(db, queue, registry),
    },
    {
      provide: NotificationDestinationService,
      inject: [DB, SECRET_STORE, AlertDeliveryRegistry, ENV],
      useFactory: (db: Db, secrets: SecretStore, registry: AlertDeliveryRegistry, env: ApiEnv) =>
        new NotificationDestinationService(db, secrets, registry, { baseUrl: env.OCSO_PUBLIC_URL }),
    },
  ],
  exports: [AlertService, AlertRuleService, NotificationDestinationService],
})
export class AlertsModule {}
