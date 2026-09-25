import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import {
  BeginOAuthInput,
  CreatePersonalConnectionInput,
  HeaderAuthInput,
  McpConnectionService,
  PersonalConnectionService,
  type ActorContext,
} from '@ocso/application';
import { z } from 'zod';
import { Actor, Capability, RequirePermission } from '../../common/decorators.js';

const Id = z.uuid();

/**
 * A user's own connections to admin-published USER-scope templates. The
 * service restricts discover/auth/health to the owner (their credentials).
 */
@Controller('v1/mcp/personal')
export class McpPersonalController {
  constructor(
    @Inject(PersonalConnectionService) private readonly personal: PersonalConnectionService,
    @Inject(McpConnectionService) private readonly connections: McpConnectionService,
  ) {}

  @Capability({ name: 'mcp.list_personal_templates', summary: 'List the MCP connection templates you can connect for yourself.', tags: ['personal'] })
  @Get('templates')
  @RequirePermission(Permission.MCP_CONNECT_PERSONAL)
  templates(@Actor() actor: ActorContext) {
    return this.personal.listTemplates(actor);
  }

  @Capability({ name: 'mcp.list_my_connections', summary: 'List your personal MCP connections.', tags: ['personal', 'mine'] })
  @Get()
  @RequirePermission(Permission.MCP_CONNECT_PERSONAL)
  mine(@Actor() actor: ActorContext) {
    return this.personal.listMine(actor);
  }

  @Capability({ name: 'mcp.create_personal_connection', summary: 'Create a personal MCP connection from a template (you authorize it in the UI).', risk: 'LOW_WRITE', tags: ['personal'] })
  @Post()
  @RequirePermission(Permission.MCP_CONNECT_PERSONAL)
  create(@Actor() actor: ActorContext, @Body({ schema: CreatePersonalConnectionInput }) body: CreatePersonalConnectionInput) {
    return this.personal.create(actor, body);
  }

  @Capability({ name: 'mcp.get_personal_connection', summary: 'Get one of your personal MCP connections.', tags: ['personal'] })
  @Get(':id')
  @RequirePermission(Permission.MCP_CONNECT_PERSONAL)
  get(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    return this.connections.get(actor, id);
  }

  @Capability({ name: 'mcp.list_personal_connection_tools', summary: 'List the tools of one of your personal MCP connections.', tags: ['personal'] })
  @Get(':id/tools')
  @RequirePermission(Permission.MCP_CONNECT_PERSONAL)
  tools(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    return this.connections.listTools(actor, id);
  }

  @Capability({ name: 'mcp.discover_personal_connection_tools', summary: 'Discover the tools of one of your personal MCP connections.', risk: 'LOW_WRITE', tags: ['personal'] })
  @Post(':id/discover')
  @HttpCode(200)
  @RequirePermission(Permission.MCP_CONNECT_PERSONAL)
  discover(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    return this.connections.discover(actor, id);
  }

  @Capability({ exclude: 'takes a credential (header token); set it on the MCP connections page (My connections)' })
  @Post(':id/auth/header')
  @HttpCode(200)
  @RequirePermission(Permission.MCP_CONNECT_PERSONAL)
  headerAuth(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: HeaderAuthInput }) body: HeaderAuthInput) {
    return this.connections.setHeaderAuth(actor, id, body);
  }

  @Capability({ exclude: 'starts a browser OAuth flow; authorize connections on the MCP connections page (My connections)' })
  @Post(':id/oauth/begin')
  @HttpCode(200)
  @RequirePermission(Permission.MCP_CONNECT_PERSONAL)
  beginOAuth(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: BeginOAuthInput }) body: BeginOAuthInput) {
    return this.connections.beginOAuth(actor, id, body);
  }

  @Capability({ name: 'mcp.check_personal_connection_health', summary: 'Run a health check on one of your personal MCP connections.', risk: 'LOW_WRITE', tags: ['personal'] })
  @Post(':id/health')
  @HttpCode(200)
  @RequirePermission(Permission.MCP_CONNECT_PERSONAL)
  checkHealth(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    return this.connections.checkHealth(actor, id);
  }

  @Capability({ name: 'mcp.delete_personal_connection', summary: 'Remove one of your personal MCP connections.', risk: 'LOW_WRITE', tags: ['personal'] })
  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(Permission.MCP_CONNECT_PERSONAL)
  async remove(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string): Promise<void> {
    await this.connections.delete(actor, id);
  }
}
