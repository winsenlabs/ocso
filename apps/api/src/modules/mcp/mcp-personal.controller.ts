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
import { Actor, RequirePermission } from '../../common/decorators.js';

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

  @Get('templates')
  @RequirePermission(Permission.MCP_CONNECT_PERSONAL)
  templates(@Actor() actor: ActorContext) {
    return this.personal.listTemplates(actor);
  }

  @Get()
  @RequirePermission(Permission.MCP_CONNECT_PERSONAL)
  mine(@Actor() actor: ActorContext) {
    return this.personal.listMine(actor);
  }

  @Post()
  @RequirePermission(Permission.MCP_CONNECT_PERSONAL)
  create(@Actor() actor: ActorContext, @Body({ schema: CreatePersonalConnectionInput }) body: CreatePersonalConnectionInput) {
    return this.personal.create(actor, body);
  }

  @Get(':id')
  @RequirePermission(Permission.MCP_CONNECT_PERSONAL)
  get(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    return this.connections.get(actor, id);
  }

  @Get(':id/tools')
  @RequirePermission(Permission.MCP_CONNECT_PERSONAL)
  tools(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    return this.connections.listTools(actor, id);
  }

  @Post(':id/discover')
  @HttpCode(200)
  @RequirePermission(Permission.MCP_CONNECT_PERSONAL)
  discover(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    return this.connections.discover(actor, id);
  }

  @Post(':id/auth/header')
  @HttpCode(200)
  @RequirePermission(Permission.MCP_CONNECT_PERSONAL)
  headerAuth(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: HeaderAuthInput }) body: HeaderAuthInput) {
    return this.connections.setHeaderAuth(actor, id, body);
  }

  @Post(':id/oauth/begin')
  @HttpCode(200)
  @RequirePermission(Permission.MCP_CONNECT_PERSONAL)
  beginOAuth(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: BeginOAuthInput }) body: BeginOAuthInput) {
    return this.connections.beginOAuth(actor, id, body);
  }

  @Post(':id/health')
  @HttpCode(200)
  @RequirePermission(Permission.MCP_CONNECT_PERSONAL)
  checkHealth(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    return this.connections.checkHealth(actor, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(Permission.MCP_CONNECT_PERSONAL)
  async remove(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string): Promise<void> {
    await this.connections.delete(actor, id);
  }
}
