import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { WebhookDeliveryService, WebhookService } from '@ocso/application';
import type { Db } from '@ocso/db';
import { createGuardedFetch, type GuardedFetch } from '@ocso/mcp';
import type { QueueAdapter } from '@ocso/queue';
import type { SecretStore } from '@ocso/secrets';
import { DB, QUEUE, SECRET_STORE } from '../../infrastructure/tokens.js';
import { WebhooksController } from './webhooks.controller.js';

/** Webhook endpoints are external: public https only, through the SSRF guard. */
@Injectable()
class WebhookEgress implements OnModuleDestroy {
  readonly guarded: GuardedFetch = createGuardedFetch({ policy: { allowedInternalHosts: [], allowInsecureHttpHosts: [] }, network: 'PUBLIC' });

  onModuleDestroy(): void {
    this.guarded.close();
  }
}

/** Outbound event webhooks (design/04 Webhooks tab); deliveries run in the worker. */
@Module({
  controllers: [WebhooksController],
  providers: [
    WebhookEgress,
    { provide: WebhookService, inject: [DB, SECRET_STORE, QUEUE], useFactory: (db: Db, secrets: SecretStore, queue: QueueAdapter) => new WebhookService(db, secrets, queue) },
    {
      provide: WebhookDeliveryService,
      inject: [DB, SECRET_STORE, WebhookEgress],
      useFactory: (db: Db, secrets: SecretStore, egress: WebhookEgress) => new WebhookDeliveryService({ db, secrets, fetch: egress.guarded.fetch }),
    },
  ],
})
export class WebhooksModule {}
