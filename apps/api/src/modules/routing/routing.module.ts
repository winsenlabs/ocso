import { Module } from '@nestjs/common';
import { QueueService } from '@ocso/application';
import type { Db } from '@ocso/db';
import { DB } from '../../infrastructure/tokens.js';
import { RoutingController } from './routing.controller.js';

@Module({ controllers: [RoutingController], providers: [{ provide: QueueService, inject: [DB], useFactory: (db: Db) => new QueueService(db) }] })
export class RoutingModule {}
