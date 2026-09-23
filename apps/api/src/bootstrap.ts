import 'reflect-metadata';
import { Logger as NestLogger, StandardSchemaValidationPipe, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { mountAuthHandler } from './common/auth-handler.js';
import { correlationMiddleware } from './common/correlation.js';

/** Build the configured Nest application (shared by main.ts and integration tests). */
export async function createApp(options: { logger?: boolean } = {}): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    options.logger === false ? { rawBody: true, logger: false } : { rawBody: true, bufferLogs: true },
  );
  configureApp(app);
  if (options.logger !== false) app.useLogger(app.get(Logger));
  return app;
}

export function configureApp(app: NestExpressApplication): void {
  app.set('trust proxy', process.env['TRUST_PROXY'] !== 'false');
  app.disable('x-powered-by');
  // Better Auth (ADR-025) reads its own request bodies, so it is mounted before any body parser.
  mountAuthHandler(app, new NestLogger('Auth'));
  // Meta webhook payloads can reach ~3 MB (research/02).
  app.useBodyParser('json', { limit: '5mb' });
  // Web-chat attachment uploads arrive as the raw request body (size re-checked per channel).
  app.useBodyParser('raw', { type: ['image/*', 'application/pdf', 'audio/*', 'video/*', 'application/octet-stream'], limit: '25mb' });
  app.use(correlationMiddleware);
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  app.enableShutdownHooks();
}
