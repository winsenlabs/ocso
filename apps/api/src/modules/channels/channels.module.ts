import { Global, Module } from '@nestjs/common';
import { ChannelService, IngressService } from '@ocso/application';
import { ChannelRuntime } from '@ocso/agent-runtime';
import type { ChannelRegistry } from '@ocso/channels';
import type { Db } from '@ocso/db';
import type { QueueAdapter } from '@ocso/queue';
import type { SecretStore } from '@ocso/secrets';
import { CHANNEL_REGISTRY, DB, QUEUE, SECRET_STORE } from '../../infrastructure/tokens.js';
import { ChannelIngressService } from './channel-ingress.service.js';
import { ChannelsAdminController } from './channels-admin.controller.js';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller.js';

@Global()
@Module({
  controllers: [ChannelsAdminController, WhatsAppWebhookController],
  providers: [
    ChannelIngressService,
    { provide: IngressService, inject: [DB, QUEUE], useFactory: (db: Db, queue: QueueAdapter) => new IngressService(db, queue, { reopenWindowHours: 72 }) },
    {
      provide: ChannelRuntime,
      inject: [DB, CHANNEL_REGISTRY, SECRET_STORE],
      useFactory: (db: Db, registry: ChannelRegistry, secrets: SecretStore) => new ChannelRuntime(db, registry, secrets),
    },
    {
      provide: ChannelService,
      inject: [DB, SECRET_STORE, CHANNEL_REGISTRY],
      useFactory: (db: Db, secrets: SecretStore, registry: ChannelRegistry) =>
        new ChannelService(db, secrets, (kind, settings, values) => (registry.has(kind as never) ? registry.get(kind as never).validateConfig(settings, values) : [`channel kind ${kind} is not available`])),
    },
  ],
  exports: [ChannelIngressService, ChannelRuntime, IngressService, ChannelService],
})
export class ChannelsModule {}
