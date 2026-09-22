import { Global, Module } from '@nestjs/common';
import { ChannelService, IngressService } from '@ocso/application';
import { ChannelRuntime } from '@ocso/agent-runtime';
import type { ChannelRegistry } from '@ocso/channels';
import type { ApiEnv } from '@ocso/config';
import type { Db } from '@ocso/db';
import type { QueueAdapter } from '@ocso/queue';
import type { SecretStore } from '@ocso/secrets';
import { CHANNEL_REGISTRY, DB, ENV, QUEUE, SECRET_STORE } from '../../infrastructure/tokens.js';
import { ChannelIngressService } from './channel-ingress.service.js';
import { ChannelsAdminController } from './channels-admin.controller.js';
import { ChannelWebhookController } from './channel-webhook.controller.js';

@Global()
@Module({
  controllers: [ChannelsAdminController, ChannelWebhookController],
  providers: [
    ChannelIngressService,
    { provide: IngressService, inject: [DB, QUEUE], useFactory: (db: Db, queue: QueueAdapter) => new IngressService(db, queue, { reopenWindowHours: 72 }) },
    {
      provide: ChannelRuntime,
      inject: [DB, CHANNEL_REGISTRY, SECRET_STORE, ENV],
      useFactory: (db: Db, registry: ChannelRegistry, secrets: SecretStore, env: ApiEnv) => new ChannelRuntime(db, registry, secrets, { publicUrl: env.OCSO_PUBLIC_URL }),
    },
    {
      provide: ChannelService,
      inject: [DB, SECRET_STORE, CHANNEL_REGISTRY],
      useFactory: (db: Db, secrets: SecretStore, registry: ChannelRegistry) =>
        new ChannelService(
          db,
          secrets,
          (kind, settings, values) => (registry.has(kind) ? registry.get(kind).validateConfig(settings, values) : [`channel kind ${kind} is not available`]),
          (kind, publicKey) => registry.publicPath(kind, publicKey),
        ),
    },
  ],
  exports: [ChannelIngressService, ChannelRuntime, IngressService, ChannelService],
})
export class ChannelsModule {}
