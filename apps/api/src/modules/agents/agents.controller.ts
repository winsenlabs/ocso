import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Res } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import { AgentInput, AgentOwnersInput, AgentPatch, AgentService, ApprovalService, WithApproval, requestApproval, type ActorContext } from '@ocso/application';
import type { Response } from 'express';
import { z } from 'zod';
import { Actor, CurrentPrincipal, RequireAnyPermission, RequirePermission } from '../../common/decorators.js';
import { approvalResponse } from '../approvals/approval-response.js';
import { AgentStatsService } from './agent-stats.service.js';

const Id = z.uuid();
const StatusInput = WithApproval.extend({ status: z.enum(['LIVE', 'PAUSED']) });
type StatusInput = z.infer<typeof StatusInput>;
const PatchBody = AgentPatch.extend(WithApproval.shape);
type PatchBody = z.infer<typeof PatchBody>;
type ApprovalBody = z.infer<typeof WithApproval>;

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
    @Inject(ApprovalService) private readonly approvals: ApprovalService,
  ) {}

  /** Only the agents the caller can read (their teams' agents; every agent for the Tech admin). */
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
    // Maker–checker state for the header badge and the submit modal (readable by whoever reads the agent).
    const approval = await this.approvals.objectState(principal, 'agent', id);
    return { ...agent, stats: stats.get(id) ?? null, approval };
  }

  @Post()
  @RequirePermission(Permission.AGENTS_MANAGE)
  create(@Actor() actor: ActorContext, @Body({ schema: AgentInput }) body: AgentInput) {
    return this.agents.create(actor, body);
  }

  /**
   * A draft agent changes directly (200). Once approved, a change is a proposal:
   * 202 `{proposal}` with `approval: {checkerId, reason}`, else 409 approval_required.
   */
  @Patch(':id')
  @RequirePermission(Permission.AGENTS_MANAGE)
  update(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: PatchBody }) body: PatchBody, @Res({ passthrough: true }) res: Response) {
    const { approval, ...patch } = body;
    return approvalResponse(res, requestApproval(this.approvals, actor, { objectKind: 'agent', objectId: id, action: 'UPDATE', payload: patch }, approval, () => this.agents.update(actor, id, patch)));
  }

  /** Deleting an agent (agents.delete, Head) is always a proposal: 202 `{proposal}`, or 409 approval_required. */
  @Delete(':id')
  @RequirePermission(Permission.AGENTS_DELETE)
  remove(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: WithApproval }) body: ApprovalBody, @Res({ passthrough: true }) res: Response) {
    return approvalResponse(res, requestApproval(this.approvals, actor, { objectKind: 'agent', objectId: id, action: 'DELETE' }, body.approval, null));
  }

  /**
   * Replace the owning teams. Tech admin (agents.assign_owner): any teams, for
   * governance. Lead (agents.manage): only within their own teams. Audited.
   */
  @Put(':id/owners')
  @RequireAnyPermission(Permission.AGENTS_ASSIGN_OWNER, Permission.AGENTS_MANAGE)
  setOwners(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: AgentOwnersInput }) body: AgentOwnersInput) {
    return this.agents.setOwners(actor, id, body.teamIds);
  }

  /**
   * PAUSED (agents.pause) is a stop action: immediate, never gated. LIVE — going
   * live or resuming — is an ACTIVATE and always a proposal: 202 `{proposal}`
   * with `approval`, else 409 approval_required.
   */
  @Post(':id/status')
  @RequireAnyPermission(Permission.AGENTS_MANAGE, Permission.AGENTS_PAUSE)
  setStatus(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: StatusInput }) body: StatusInput, @Res({ passthrough: true }) res: Response) {
    if (body.status === 'PAUSED') return this.agents.setStatus(actor, id, 'PAUSED');
    return approvalResponse(res, requestApproval(this.approvals, actor, { objectKind: 'agent', objectId: id, action: 'ACTIVATE' }, body.approval, null));
  }
}
