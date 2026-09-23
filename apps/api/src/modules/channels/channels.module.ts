import { Global, Module } from '@nestjs/common';
import { ChannelService, IngressService, MessageTemplateService, setIdentityDisplay } from '@ocso/application';
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
import { ChannelTemplatesController, MessageTemplateChannelsController } from './channel-templates.controller.js';
import { SESSION_WINDOW_HOURS, TEMPLATE_PROVIDERS } from './templates.providers.js';

/** Installs the channel plugins' identity display (masking) hook for list views (application masking.ts). */
const IDENTITY_DISPLAY = Symbol('IDENTITY_DISPLAY');

@Global()
@Module({
  controllers: [ChannelsAdminController, ChannelWebhookController, ChannelTemplatesController, MessageTemplateChannelsController],
  providers: [
    ...TEMPLATE_PROVIDERS,
    {
      provide: IDENTITY_DISPLAY,
      inject: [CHANNEL_REGISTRY],
      useFactory: (registry: ChannelRegistry) => {
        setIdentityDisplay((kind, value) => registry.displayIdentity(kind, value));
        return true;
      },
    },
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
          (kind, publicKey) => registry.paths(kind, publicKey),
        ),
    },
  ],
  exports: [ChannelIngressService, ChannelRuntime, IngressService, ChannelService, MessageTemplateService, SESSION_WINDOW_HOURS],
})
export class ChannelsModule {}
