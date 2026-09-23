import { Body, Controller, Get, Inject, Param, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Permission } from '@ocso/auth';
import { AgentToolGrantService, ApprovalService, SetAgentToolGrantsInput, TOOL_GRANT_KIND, WithApproval, requestApproval, withAppliedGrants, type ActorContext } from '@ocso/application';
import { DomainError } from '@ocso/domain';
import { z } from 'zod';
import { Actor, RequirePermission } from '../../common/decorators.js';

const AgentId = z.uuid();
const SetGrantsBody = SetAgentToolGrantsInput.extend(WithApproval.shape);
type SetGrantsBody = z.input<typeof SetGrantsBody>;

/** Per-agent tool grants with argument rules (Lead). */
@Controller('v1/agents')
export class AgentToolsController {
  constructor(
    @Inject(AgentToolGrantService) private readonly grants: AgentToolGrantService,
    @Inject(ApprovalService) private readonly approvals: ApprovalService,
  ) {}

  @Get(':agentId/tools')
  @RequirePermission(Permission.AGENTS_READ)
  list(@Actor() actor: ActorContext, @Param('agentId', { schema: AgentId }) agentId: string) {
    return this.grants.list(actor, agentId);
  }

  /**
   * Replace the grant set (PM/research/11b). A draft agent's set applies whole (200). Once the agent has been
   * approved, removals and narrowing apply at once and what widens access is an `agent_tool_grant` proposal:
   * 202 `{ proposal, applied, ...tools }` with `approval`, else 409 approval_required (saying what already applied).
   */
  @Put(':agentId/tools')
  @RequirePermission(Permission.AGENT_TOOLS_MANAGE)
  async set(@Actor() actor: ActorContext, @Param('agentId', { schema: AgentId }) agentId: string, @Body({ schema: SetGrantsBody }) body: SetGrantsBody, @Res({ passthrough: true }) res: Response) {
    const { approval, ...grants } = body;
    const change = await this.grants.replace(actor, agentId, grants);
    if (!change.proposed) return { ...change.view, applied: change.applied, proposal: null };
    try {
      const outcome = await requestApproval(this.approvals, actor, { objectKind: TOOL_GRANT_KIND, objectId: agentId, action: 'UPDATE', payload: { grants: change.proposed } }, approval, null);
      if (outcome.kind !== 'proposed') throw new Error('a widening grant change is always a proposal');
      res.status(202);
      return { ...(await this.grants.list(actor, agentId)), applied: change.applied, proposal: outcome.proposal };
    } catch (err) {
      throw err instanceof DomainError ? withAppliedGrants(err, change.applied) : err;
    }
  }
}
