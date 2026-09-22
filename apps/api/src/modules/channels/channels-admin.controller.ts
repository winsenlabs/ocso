import { Body, Controller, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import { ChannelInput, ChannelPatch, ChannelService, type ActorContext } from '@ocso/application';
import type { ChannelRegistry } from '@ocso/channels';
import { z } from 'zod';
import { Actor, RequirePermission } from '../../common/decorators.js';
import { CHANNEL_REGISTRY } from '../../infrastructure/tokens.js';

const Id = z.uuid();

/** Channel administration (design/04 Channels tab). Secrets are write-only. */
@Controller('v1/channels')
export class ChannelsAdminController {
  constructor(
    @Inject(ChannelService) private readonly channels: ChannelService,
    @Inject(CHANNEL_REGISTRY) private readonly registry: ChannelRegistry,
  ) {}

  @Get()
  @RequirePermission(Permission.CHANNELS_READ)
  list() {
    return this.channels.list();
  }

  /** Channel kinds with their capability declarations, for the "Add channel" form. */
  @Get('kinds')
  @RequirePermission(Permission.CHANNELS_READ)
  kinds() {
    return this.registry.kinds().map((kind) => ({ kind }));
  }

  @Get(':id')
  @RequirePermission(Permission.CHANNELS_READ)
  get(@Param('id', { schema: Id }) id: string) {
    return this.channels.get(id);
  }

  @Post()
  @RequirePermission(Permission.CHANNELS_MANAGE)
  create(@Actor() actor: ActorContext, @Body({ schema: ChannelInput }) body: ChannelInput) {
    return this.channels.create(actor, body);
  }

  @Patch(':id')
  @RequirePermission(Permission.CHANNELS_MANAGE)
  update(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: ChannelPatch }) body: ChannelPatch) {
    return this.channels.update(actor, id, body);
  }
}
