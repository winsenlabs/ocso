import { Module } from '@nestjs/common';
import { ContextBuilder, CopilotService, HotContextCache, ModelGateway } from '@ocso/agent-runtime';
import { SettingsService } from '@ocso/application';
import { CachedProviderAdapterSource } from '@ocso/bootstrap';
import type { Db } from '@ocso/db';
import type { ModelInputCapabilities } from '@ocso/prompt-compiler';
import { DB } from '../../infrastructure/tokens.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { CopilotController } from './copilot.controller.js';

const TEXT_ONLY: ModelInputCapabilities = { imageInput: false, fileInput: false, audioInput: false };

/** On-demand copilot drafts for the workspace; proactive drafts run in the worker. */
@Module({
  imports: [ConversationsModule],
  controllers: [CopilotController],
  providers: [
    {
      provide: CopilotService,
      inject: [DB, ModelGateway, CachedProviderAdapterSource, SettingsService],
      useFactory: async (db: Db, gateway: ModelGateway, source: CachedProviderAdapterSource, settings: SettingsService) =>
        new CopilotService({
          db,
          gateway,
          // Small hot cache: the API drafts on demand; the worker owns the main turn cache.
          context: new ContextBuilder(db, new HotContextCache(200), { historyWindow: 20, mediaWindow: 6, timezone: (await settings.deployment()).timezone }),
          capabilitiesFor: (profileId) => source.capabilitiesForProfile(profileId).catch(() => TEXT_ONLY),
        }),
    },
  ],
})
export class CopilotModule {}
