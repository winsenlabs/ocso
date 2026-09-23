import { Body, Controller, Get, Inject, Param, Patch, Post, Put } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import { AgentInput, AgentOwnersInput, AgentPatch, AgentService, type ActorContext } from '@ocso/application';
import { z } from 'zod';
import { Actor, CurrentPrincipal, RequireAnyPermission, RequirePermission } from '../../common/decorators.js';
import { AgentStatsService } from './agent-stats.service.js';

const Id = z.uuid();
const StatusInput = z.object({ status: z.enum(['LIVE', 'PAUSED']) });
type StatusInput = z.infer<typeof StatusInput>;

/**
 * Virtual agents (design/02 header + Home agent cards). Every read and write
 * is scoped by owning team in AgentService (ADR-026): another team's agent is
 * a 404.
 */
@Controller('v1/agents')
export class AgentsController {
  constructor(
    @Inject(AgentService) private readonly agents: AgentService,
    @Inject(AgentStatsService) private readonly stats: AgentStatsService,
  ) {}

  /** Only the agents the caller can read (their teams' agents; every agent for the Tech Admin). */
  @Get()
  @RequirePermission(Permission.AGENTS_READ)
  async list(@CurrentPrincipal() principal: Principal) {
    const [agents, stats] = await Promise.all([this.agents.list(principal), this.stats.summaries()]);
    return agents.map((a) => ({ ...a, stats: stats.get(a.id) ?? null }));
  }

  @Get(':id')
  @RequirePermission(Permission.AGENTS_READ)
  async get(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string) {
    const [agent, stats] = await Promise.all([this.agents.get(principal, id), this.stats.summaries()]);
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

  /**
   * Replace the owning teams. Tech Admin (agents.assign_owner): any teams, for
   * governance. CS Lead (agents.manage): only within their own teams. Audited.
   */
  @Put(':id/owners')
  @RequireAnyPermission(Permission.AGENTS_ASSIGN_OWNER, Permission.AGENTS_MANAGE)
  setOwners(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: AgentOwnersInput }) body: AgentOwnersInput) {
    return this.agents.setOwners(actor, id, body.teamIds);
  }

  @Post(':id/status')
  @RequirePermission(Permission.AGENTS_MANAGE)
  setStatus(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: StatusInput }) body: StatusInput) {
    return this.agents.setStatus(actor, id, body.status);
  }
}
