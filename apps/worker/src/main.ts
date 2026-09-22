import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';
import { WorkerLifecycleService } from './runtime/lifecycle.service.js';
import { startHealthServer } from './health-server.js';

const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn'] });
app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
const lifecycle = app.get(WorkerLifecycleService);
const server = startHealthServer(Number(process.env['HEALTH_PORT'] ?? 4100), async () => lifecycle.ready);
process.once('SIGTERM', () => server.close());
