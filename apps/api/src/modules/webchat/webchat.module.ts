import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { WebChatController } from './webchat.controller.js';
import { WebChatCorsMiddleware } from './webchat-cors.middleware.js';
import { WebChatIdentityService } from './webchat-identity.service.js';
import { WebChatMessagesService } from './webchat-messages.service.js';
import type { ApiEnv } from '@ocso/config';
import { ENV } from '../../infrastructure/tokens.js';
import { WEBCHAT_RATE_LIMITS, WebChatRateLimiter } from './webchat-rate-limit.js';

@Module({
  imports: [ConversationsModule],
  controllers: [WebChatController],
  providers: [WebChatIdentityService, WebChatMessagesService, { provide: WebChatRateLimiter, inject: [ENV], useFactory: (env: ApiEnv) => new WebChatRateLimiter({ ...WEBCHAT_RATE_LIMITS, ...env.OCSO_WEBCHAT_RATE_LIMITS }) }],
})
export class WebChatModule implements NestModule {
  /** CORS (incl. preflights) for every public web chat route, the CSAT one included. */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(WebChatCorsMiddleware).forRoutes({ path: 'public/webchat/*path', method: RequestMethod.ALL });
  }
}
