import { Module } from '@nestjs/common';
import { HumanControlService, InboxService } from '@ocso/application';
import type { Db } from '@ocso/db';
import { DB } from '../../infrastructure/tokens.js';
import { ConversationAccessService } from './conversation-access.service.js';
import { ConversationsController } from './conversations.controller.js';
import { ConversationToolsController } from './conversation-tools.controller.js';
import { HumanToolService } from '@ocso/agent-runtime';
import { McpToolProviderFactory } from '@ocso/bootstrap';
import { SettingsService } from '@ocso/application';
import type { SecretStore } from '@ocso/secrets';
import { createAjvValidator } from '@ocso/tools';
import { SECRET_STORE } from '../../infrastructure/tokens.js';

@Module({
  controllers: [ConversationsController, ConversationToolsController],
  providers: [
    ConversationAccessService,
    { provide: InboxService, inject: [DB], useFactory: (db: Db) => new InboxService(db) },
    { provide: HumanControlService, inject: [DB], useFactory: (db: Db) => new HumanControlService(db) },
    {
      provide: HumanToolService,
      inject: [DB, SECRET_STORE, SettingsService],
      useFactory: (db: Db, secrets: SecretStore, settings: SettingsService) => new HumanToolService(db, new McpToolProviderFactory(db, secrets, settings), createAjvValidator()),
    },
  ],
  exports: [ConversationAccessService],
})
export class ConversationsModule {}
