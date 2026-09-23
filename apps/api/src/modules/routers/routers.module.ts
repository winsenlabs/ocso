import { Module } from '@nestjs/common';
import { RouterService } from '@ocso/application';
import { ModelGateway, createRouterClassifier } from '@ocso/agent-runtime';
import type { Db } from '@ocso/db';
import { DB } from '../../infrastructure/tokens.js';
import { RoutersController } from './routers.controller.js';

/** Routers (PM/research/11 §5.7); the simulator classifies with the same gateway as the worker. */
@Module({
  controllers: [RoutersController],
  providers: [{ provide: RouterService, inject: [DB, ModelGateway], useFactory: (db: Db, gateway: ModelGateway) => new RouterService(db, createRouterClassifier(gateway)) }],
  exports: [RouterService],
})
export class RoutersModule {}
