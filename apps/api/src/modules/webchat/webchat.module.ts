import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { WebChatController } from './webchat.controller.js';
import { WebChatIdentityService } from './webchat-identity.service.js';
import { WebChatMessagesService } from './webchat-messages.service.js';

@Module({
  imports: [ConversationsModule],
  controllers: [WebChatController],
  providers: [WebChatIdentityService, WebChatMessagesService],
})
export class WebChatModule {}
