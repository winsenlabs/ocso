import { Module } from '@nestjs/common';
import { AgentService, EscalationRuleService, PromptService } from '@ocso/application';
import type { Db } from '@ocso/db';
import { DB } from '../../infrastructure/tokens.js';
import { AgentStatsService } from './agent-stats.service.js';
import { AgentsController } from './agents.controller.js';
import { PromptsController } from './prompts.controller.js';

@Module({
  controllers: [AgentsController, PromptsController],
  providers: [
    AgentStatsService,
    { provide: AgentService, inject: [DB], useFactory: (db: Db) => new AgentService(db) },
    { provide: PromptService, inject: [DB], useFactory: (db: Db) => new PromptService(db) },
    { provide: EscalationRuleService, inject: [DB], useFactory: (db: Db) => new EscalationRuleService(db) },
  ],
  exports: [AgentService, PromptService, EscalationRuleService],
})
export class AgentsModule {}
