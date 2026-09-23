import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query, Res } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import {
  ApprovalService,
  ApproveConnectionInput,
  BeginOAuthInput,
  ClassifyToolsInput,
  CreateConnectionInput,
  HeaderAuthInput,
  McpConnectionService,
  WithApproval,
  requestApproval,
  requestStagedApproval,
  type ActorContext,
} from '@ocso/application';
import type { Response } from 'express';
import { z } from 'zod';
import { Actor, Capability, CurrentPrincipal, RequirePermission } from '../../common/decorators.js';
import { approvalResponse } from '../approvals/approval-response.js';
import { proposeOnly, withApprovalState, OptionalApproval, type ApprovalBody } from '../settings/platform-approvals.js';

const Id = z.uuid();
const ToolsQuery = z.object({ includeRemoved: z.enum(['true', 'false']).optional() });
const HistoryQuery = z.object({ limit: z.coerce.number().int().min(1).max(1_000).optional() });
const ClassifyBody = ClassifyToolsInput.extend(WithApproval.shape);
type ClassifyBody = z.infer<typeof ClassifyBody>;
const ApproveBody = ApproveConnectionInput.extend(WithApproval.shape);
type ApproveBody = z.infer<typeof ApproveBody>;
const HeaderBody = HeaderAuthInput.extend(WithApproval.shape);
type HeaderBody = z.infer<typeof HeaderBody>;

/**
 * Shared MCP connections and USER-scope templates (Tech admin). The wizard:
 * create → discover → auth/header | oauth/begin → tools (classify) → approve.
 * Route permissions are the coarse gate; the service re-checks per resource.
 *
 * Maker–checker (PM/research/11 §4, approvals.check.platform) for shared connections and templates: the
 * wizard edits a draft directly; "approve" records the agent policy and submits the ACTIVATE proposal
 * (activation re-contacts the server in the worker); enabling is ACTIVATE, deleting DELETE; once approved,
 * tool approvals, the policy and a header credential are UPDATE proposals. Disabling is immediate. Personal
 * connections are never proposals.
 */
@Controller('v1/mcp/connections')
export class McpConnectionsController {
  constructor(
    @Inject(McpConnectionService) private readonly connections: McpConnectionService,
    @Inject(ApprovalService) private readonly approvals: ApprovalService,
  ) {}

  @Capability({ name: 'mcp.list_connections', summary: 'List shared MCP tool connections with their status, health and approval state.' })
  @Get()
  @RequirePermission(Permission.MCP_READ)
  async list(@Actor() actor: ActorContext, @CurrentPrincipal() principal: Principal) {
    return withApprovalState(this.approvals, principal, 'mcp_connection', await this.connections.list(actor));
  }

  @Capability({ name: 'mcp.create_connection', summary: 'Register a shared MCP connection by URL as a draft (credentials are set in the UI).' })
  @Post()
  @RequirePermission(Permission.MCP_MANAGE)
  create(@Actor() actor: ActorContext, @Body({ schema: CreateConnectionInput }) body: CreateConnectionInput) {
    return this.connections.createDraft(actor, body);
  }

  @Capability({ name: 'mcp.get_connection', summary: 'Get one MCP connection.' })
  @Get(':id')
  @RequirePermission(Permission.MCP_READ)
  async get(@Actor() actor: ActorContext, @CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string) {
    const view = await this.connections.get(actor, id);
    return view.kind === 'PERSONAL' ? view : (await withApprovalState(this.approvals, principal, 'mcp_connection', [view]))[0];
  }

  @Capability({ name: 'mcp.discover_connection_tools', summary: 'Discover the tools an MCP connection offers.', risk: 'LOW_WRITE' })
  @Post(':id/discover')
  @HttpCode(200)
  @RequirePermission(Permission.MCP_MANAGE)
  discover(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    return this.connections.discover(actor, id);
  }

  @Capability({ name: 'mcp.rediscover_connection_tools', summary: "Re-discover an MCP connection's tools after the server changed.", risk: 'LOW_WRITE' })
  @Post(':id/rediscover')
  @HttpCode(200)
  @RequirePermission(Permission.MCP_MANAGE)
  rediscover(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    return this.connections.rediscover(actor, id);
  }

  @Capability({ exclude: 'takes a credential (header token); set it on the Connections page' })
  @Post(':id/auth/header')
  @HttpCode(200)
  @RequirePermission(Permission.MCP_MANAGE)
  async headerAuth(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: HeaderBody }) body: HeaderBody, @Res({ passthrough: true }) res: Response) {
    const { approval, ...input } = body;
    if (!(await this.connections.isGoverned(actor, id))) return this.connections.setHeaderAuth(actor, id, input);
    return approvalResponse(
      res,
      requestStagedApproval(this.approvals, actor, { objectKind: 'mcp_connection', objectId: id, action: 'UPDATE' }, approval, () => this.connections.setHeaderAuth(actor, id, input), () =>
        this.connections.stageHeaderCredential(actor, id, input),
      ),
    );
  }

  @Capability({ exclude: 'starts a browser OAuth flow; authorize connections on the Connections page' })
  @Post(':id/oauth/begin')
  @HttpCode(200)
  @RequirePermission(Permission.MCP_MANAGE)
  beginOAuth(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: BeginOAuthInput }) body: BeginOAuthInput) {
    return this.connections.beginOAuth(actor, id, body);
  }

  @Capability({ name: 'mcp.list_connection_tools', summary: "List an MCP connection's tools and how they are classified." })
  @Get(':id/tools')
  @RequirePermission(Permission.MCP_READ)
  tools(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Query({ schema: ToolsQuery }) query: z.infer<typeof ToolsQuery>) {
    return this.connections.listTools(actor, id, { includeRemoved: query.includeRemoved === 'true' });
  }

  @Capability({ name: 'mcp.classify_connection_tools', summary: "Classify an MCP connection's tools: risk class, approved, who may run them." })
  @Put(':id/tools')
  @RequirePermission(Permission.MCP_MANAGE)
  classify(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: ClassifyBody }) body: ClassifyBody, @Res({ passthrough: true }) res: Response) {
    const { approval, ...input } = body;
    return approvalResponse(res, requestApproval(this.approvals, actor, { objectKind: 'mcp_connection', objectId: id, action: 'UPDATE', payload: { tools: input.tools } }, approval, () => this.connections.classifyTools(actor, id, input)));
  }

  /**
   * A draft: records the agent policy, then its activation is an ACTIVATE proposal (202 with `approval`,
   * else 409 approval_required — the policy is kept). Approved: a policy change is an UPDATE proposal.
   */
  @Capability({ name: 'mcp.approve_connection', summary: "Set an MCP connection's agent policy and submit its activation (needs approval)." })
  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission(Permission.MCP_MANAGE)
  async approve(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: ApproveBody }) body: ApproveBody, @Res({ passthrough: true }) res: Response) {
    const { approval, ...policy } = body;
    const state = await this.approvals.objectState(actor.principal!, 'mcp_connection', id);
    if (state.approved) {
      return approvalResponse(res, requestApproval(this.approvals, actor, { objectKind: 'mcp_connection', objectId: id, action: 'UPDATE', payload: { policy } }, approval, null));
    }
    await this.connections.approve(actor, id, policy);
    return proposeOnly(res, this.approvals, actor, { kind: 'mcp_connection', id, action: 'ACTIVATE' }, approval);
  }

  @Capability({ name: 'mcp.disable_connection', summary: 'Disable an MCP connection (applies at once).', stop: true, tags: ['stop', 'turn off'] })
  @Post(':id/disable')
  @HttpCode(200)
  @RequirePermission(Permission.MCP_MANAGE)
  disable(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    return this.connections.disable(actor, id);
  }

  @Capability({ name: 'mcp.enable_connection', summary: 'Re-enable an MCP connection (needs approval).' })
  @Post(':id/enable')
  @HttpCode(200)
  @RequirePermission(Permission.MCP_MANAGE)
  enable(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: OptionalApproval }) body: ApprovalBody, @Res({ passthrough: true }) res: Response) {
    return proposeOnly(res, this.approvals, actor, { kind: 'mcp_connection', id, action: 'ACTIVATE' }, body?.approval);
  }

  /** Shared connections and templates: always a proposal (DELETE). An admin revoking a personal connection: immediate (204). */
  @Capability({ name: 'mcp.delete_connection', summary: 'Delete an MCP connection (always needs approval).' })
  @Delete(':id')
  @RequirePermission(Permission.MCP_MANAGE)
  async remove(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: OptionalApproval }) body: ApprovalBody, @Res({ passthrough: true }) res: Response) {
    if (await this.connections.isGoverned(actor, id)) return proposeOnly(res, this.approvals, actor, { kind: 'mcp_connection', id, action: 'DELETE' }, body?.approval);
    await this.connections.delete(actor, id);
    res.status(204);
    return undefined;
  }

  @Capability({ name: 'mcp.check_connection_health', summary: 'Run a health check on an MCP connection now.', risk: 'LOW_WRITE' })
  @Post(':id/health')
  @HttpCode(200)
  @RequirePermission(Permission.MCP_MANAGE)
  checkHealth(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    return this.connections.checkHealth(actor, id);
  }

  @Capability({ name: 'mcp.get_connection_health_history', summary: "An MCP connection's recent health checks." })
  @Get(':id/health')
  @RequirePermission(Permission.MCP_READ)
  healthHistory(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Query({ schema: HistoryQuery }) query: z.infer<typeof HistoryQuery>) {
    return this.connections.healthHistory(actor, id, query.limit);
  }
}
