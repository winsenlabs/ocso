import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { loggerOptions } from '@ocso/observability';
import { AuthGuard } from './common/auth.guard.js';
import { OcsoExceptionFilter } from './common/exception.filter.js';
import { TracingInterceptor } from './common/tracing.interceptor.js';
import { InfrastructureModule } from './infrastructure/infrastructure.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { ModelsModule } from './modules/models/models.module.js';
import { McpModule } from './modules/mcp/mcp.module.js';
import { AlertsModule } from './modules/alerts/alerts.module.js';
import { AgentsModule } from './modules/agents/agents.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { BlobsModule } from './modules/blobs/blobs.module.js';
import { ChannelsModule } from './modules/channels/channels.module.js';
import { ConversationsModule } from './modules/conversations/conversations.module.js';
import { CustomersModule } from './modules/customers/customers.module.js';
import { RealtimeModule } from './modules/realtime/realtime.module.js';
import { RoutingModule } from './modules/routing/routing.module.js';
import { WebChatModule } from './modules/webchat/webchat.module.js';
import { ModelRuntimeModule } from './modules/model-runtime/model-runtime.module.js';
import { InternalAgentModule } from './modules/internal-agent/internal-agent.module.js';

/** Feature modules are registered here; each owns one domain area (build rule §2). */
export const FEATURE_MODULES = [
  HealthModule,
  AuthModule,
  UsersModule,
  SettingsModule,
  RealtimeModule,
  ModelRuntimeModule,
  ChannelsModule,
  ConversationsModule,
  AgentsModule,
  RoutingModule,
  CustomersModule,
  WebChatModule,
  BlobsModule,
  AuditModule,
  ModelsModule,
  McpModule,
  AlertsModule,
  InternalAgentModule,
];

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        ...loggerOptions({ service: 'ocso-api', version: process.env['APP_VERSION'] ?? 'dev', level: process.env['LOG_LEVEL'] ?? 'info' }),
        autoLogging: { ignore: (req) => (req.url ?? '').startsWith('/health') },
        customProps: (req) => ({ correlationId: (req as { correlationId?: string }).correlationId }),
      },
    }),
    InfrastructureModule,
    ...FEATURE_MODULES,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: OcsoExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: TracingInterceptor },
  ],
})
export class AppModule {}
