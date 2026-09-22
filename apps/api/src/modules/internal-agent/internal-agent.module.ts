import { Module } from '@nestjs/common';
import { ModelGateway } from '@ocso/agent-runtime';
import type { Db } from '@ocso/db';
import { InternalActionService, InternalAgentService, InternalToolRegistry } from '@ocso/internal-agent';
import { DB } from '../../infrastructure/tokens.js';
import { InternalAgentController } from './internal-agent.controller.js';

@Module({
  controllers: [InternalAgentController],
  providers: [
    { provide: InternalToolRegistry, useFactory: () => new InternalToolRegistry() },
    { provide: InternalActionService, inject: [DB, InternalToolRegistry], useFactory: (db: Db, r: InternalToolRegistry) => new InternalActionService(db, r) },
    {
      provide: InternalAgentService,
      inject: [DB, ModelGateway, InternalToolRegistry, InternalActionService],
      useFactory: (db: Db, gateway: ModelGateway, r: InternalToolRegistry, a: InternalActionService) => new InternalAgentService(db, gateway, r, a),
    },
  ],
})
export class InternalAgentModule {}
