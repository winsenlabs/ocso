import { Module } from '@nestjs/common';
import { HumanControlService, InboxService } from '@ocso/application';
import type { Db } from '@ocso/db';
import { DB } from '../../infrastructure/tokens.js';
import { ConversationAccessService } from './conversation-access.service.js';
import { ConversationsController } from './conversations.controller.js';

@Module({
  controllers: [ConversationsController],
  providers: [
    ConversationAccessService,
    { provide: InboxService, inject: [DB], useFactory: (db: Db) => new InboxService(db) },
    { provide: HumanControlService, inject: [DB], useFactory: (db: Db) => new HumanControlService(db) },
  ],
  exports: [ConversationAccessService],
})
export class ConversationsModule {}
