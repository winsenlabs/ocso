import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import {
  ApproveConnectionInput,
  BeginOAuthInput,
  ClassifyToolsInput,
  CreateConnectionInput,
  HeaderAuthInput,
  McpConnectionService,
  type ActorContext,
} from '@ocso/application';
import { z } from 'zod';
import { Actor, RequirePermission } from '../../common/decorators.js';

const Id = z.uuid();
const ToolsQuery = z.object({ includeRemoved: z.enum(['true', 'false']).optional() });
const HistoryQuery = z.object({ limit: z.coerce.number().int().min(1).max(1_000).optional() });

/**
 * Shared MCP connections and USER-scope templates (Tech Admin). The wizard:
 * create → discover → auth/header | oauth/begin → tools (classify) → approve.
 * Route permissions are the coarse gate; the service re-checks per resource.
 */
@Controller('v1/mcp/connections')
export class McpConnectionsController {
  constructor(@Inject(McpConnectionService) private readonly connections: McpConnectionService) {}

  @Get()
  @RequirePermission(Permission.MCP_READ)
  list(@Actor() actor: ActorContext) {
    return this.connections.list(actor);
  }

  @Post()
  @RequirePermission(Permission.MCP_MANAGE)
  create(@Actor() actor: ActorContext, @Body({ schema: CreateConnectionInput }) body: CreateConnectionInput) {
    return this.connections.createDraft(actor, body);
  }

  @Get(':id')
  @RequirePermission(Permission.MCP_READ)
  get(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    return this.connections.get(actor, id);
  }

  @Post(':id/discover')
  @HttpCode(200)
  @RequirePermission(Permission.MCP_MANAGE)
  discover(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    return this.connections.discover(actor, id);
  }

  @Post(':id/rediscover')
  @HttpCode(200)
  @RequirePermission(Permission.MCP_MANAGE)
  rediscover(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    return this.connections.rediscover(actor, id);
  }

  @Post(':id/auth/header')
  @HttpCode(200)
  @RequirePermission(Permission.MCP_MANAGE)
  headerAuth(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: HeaderAuthInput }) body: HeaderAuthInput) {
    return this.connections.setHeaderAuth(actor, id, body);
  }

  @Post(':id/oauth/begin')
  @HttpCode(200)
  @RequirePermission(Permission.MCP_MANAGE)
  beginOAuth(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: BeginOAuthInput }) body: BeginOAuthInput) {
    return this.connections.beginOAuth(actor, id, body);
  }

  @Get(':id/tools')
  @RequirePermission(Permission.MCP_READ)
  tools(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Query({ schema: ToolsQuery }) query: z.infer<typeof ToolsQuery>) {
    return this.connections.listTools(actor, id, { includeRemoved: query.includeRemoved === 'true' });
  }

  @Put(':id/tools')
  @RequirePermission(Permission.MCP_MANAGE)
  classify(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: ClassifyToolsInput }) body: ClassifyToolsInput) {
    return this.connections.classifyTools(actor, id, body);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission(Permission.MCP_MANAGE)
  approve(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: ApproveConnectionInput }) body: ApproveConnectionInput) {
    return this.connections.approve(actor, id, body);
  }

  @Post(':id/disable')
  @HttpCode(200)
  @RequirePermission(Permission.MCP_MANAGE)
  disable(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    return this.connections.disable(actor, id);
  }

  @Post(':id/enable')
  @HttpCode(200)
  @RequirePermission(Permission.MCP_MANAGE)
  enable(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    return this.connections.enable(actor, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(Permission.MCP_MANAGE)
  async remove(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string): Promise<void> {
    await this.connections.delete(actor, id);
  }

  @Post(':id/health')
  @HttpCode(200)
  @RequirePermission(Permission.MCP_MANAGE)
  checkHealth(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    return this.connections.checkHealth(actor, id);
  }

  @Get(':id/health')
  @RequirePermission(Permission.MCP_READ)
  healthHistory(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Query({ schema: HistoryQuery }) query: z.infer<typeof HistoryQuery>) {
    return this.connections.healthHistory(actor, id, query.limit);
  }
}
