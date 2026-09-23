import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import { AgentToolGrantService, SetAgentToolGrantsInput, type ActorContext } from '@ocso/application';
import { z } from 'zod';
import { Actor, RequirePermission } from '../../common/decorators.js';

const AgentId = z.uuid();

/** Per-agent tool grants with argument rules (Lead). */
@Controller('v1/agents')
export class AgentToolsController {
  constructor(@Inject(AgentToolGrantService) private readonly grants: AgentToolGrantService) {}

  @Get(':agentId/tools')
  @RequirePermission(Permission.AGENTS_READ)
  list(@Actor() actor: ActorContext, @Param('agentId', { schema: AgentId }) agentId: string) {
    return this.grants.list(actor, agentId);
  }

  @Put(':agentId/tools')
  @RequirePermission(Permission.AGENT_TOOLS_MANAGE)
  set(@Actor() actor: ActorContext, @Param('agentId', { schema: AgentId }) agentId: string, @Body({ schema: SetAgentToolGrantsInput }) body: SetAgentToolGrantsInput) {
    return this.grants.set(actor, agentId, body);
  }
}
