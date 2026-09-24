import { Module } from '@nestjs/common';
import { ModelGateway } from '@ocso/agent-runtime';
import type { ApprovalRegistry, AuditStore } from '@ocso/application';
import type { Db } from '@ocso/db';
import { AskOcsoTools, InternalActionService, InternalAgentService, InternalToolRegistry } from '@ocso/internal-agent';
import { AUDIT_STORE, DB } from '../../infrastructure/tokens.js';
import { APPROVAL_REGISTRY } from '../approvals/approvals.tokens.js';
import { ChatLinksController } from './chat-links.controller.js';
import { InternalAgentController } from './internal-agent.controller.js';
import { LoopbackCapabilityRunner } from './loopback-runner.js';
import { StaffChatService } from './staff-chat.service.js';

/**
 * Ask OCSO (PM/research/12): the meta tools over the capability catalog, confirmation cards, and the
 * in-process runner that calls the real API routes as the user; and Ask OCSO over staff chat channels (Slack, Teams:
 * StaffChatService, reached by channel ingress) with the chat account links behind it.
 */
@Module({
  controllers: [InternalAgentController, ChatLinksController],
  providers: [
    LoopbackCapabilityRunner,
    StaffChatService,
    { provide: InternalToolRegistry, useFactory: () => new InternalToolRegistry() },
    {
      provide: InternalActionService,
      inject: [DB, LoopbackCapabilityRunner, APPROVAL_REGISTRY],
      useFactory: (db: Db, runner: LoopbackCapabilityRunner, approvals: ApprovalRegistry) => new InternalActionService(db, runner, approvals),
    },
    {
      provide: AskOcsoTools,
      inject: [DB, LoopbackCapabilityRunner, InternalActionService, InternalToolRegistry, AUDIT_STORE],
      useFactory: (db: Db, runner: LoopbackCapabilityRunner, actions: InternalActionService, insights: InternalToolRegistry, audit: AuditStore) => new AskOcsoTools(db, runner, actions, insights, audit),
    },
    {
      provide: InternalAgentService,
      inject: [DB, ModelGateway, AskOcsoTools, InternalActionService],
      useFactory: (db: Db, gateway: ModelGateway, tools: AskOcsoTools, actions: InternalActionService) => new InternalAgentService(db, gateway, tools, actions),
    },
  ],
})
export class InternalAgentModule {}
