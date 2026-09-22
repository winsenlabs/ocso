import { Body, Controller, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import { AgentInput, AgentPatch, AgentService, type ActorContext } from '@ocso/application';
import { z } from 'zod';
import { Actor, RequirePermission } from '../../common/decorators.js';
import { AgentStatsService } from './agent-stats.service.js';

const Id = z.uuid();
const StatusInput = z.object({ status: z.enum(['LIVE', 'PAUSED']) });
type StatusInput = z.infer<typeof StatusInput>;

/** Virtual agents (design/02 header + Home agent cards). */
@Controller('v1/agents')
export class AgentsController {
  constructor(
    @Inject(AgentService) private readonly agents: AgentService,
    @Inject(AgentStatsService) private readonly stats: AgentStatsService,
  ) {}

  @Get()
  @RequirePermission(Permission.AGENTS_READ)
  async list() {
    const [agents, stats] = await Promise.all([this.agents.list(), this.stats.summaries()]);
    return agents.map((a) => ({ ...a, stats: stats.get(a.id) ?? null }));
  }

  @Get(':id')
  @RequirePermission(Permission.AGENTS_READ)
  async get(@Param('id', { schema: Id }) id: string) {
    const [agent, stats] = await Promise.all([this.agents.get(id), this.stats.summaries()]);
    return { ...agent, stats: stats.get(id) ?? null };
  }

  @Post()
  @RequirePermission(Permission.AGENTS_MANAGE)
  create(@Actor() actor: ActorContext, @Body({ schema: AgentInput }) body: AgentInput) {
    return this.agents.create(actor, body);
  }

  @Patch(':id')
  @RequirePermission(Permission.AGENTS_MANAGE)
  update(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: AgentPatch }) body: AgentPatch) {
    return this.agents.update(actor, id, body);
  }

  @Post(':id/status')
  @RequirePermission(Permission.AGENTS_MANAGE)
  setStatus(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: StatusInput }) body: StatusInput) {
    return this.agents.setStatus(actor, id, body.status);
  }
}
