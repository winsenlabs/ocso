import { randomBytes } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import { ChannelInput, ChannelPatch, ChannelService, type ActorContext } from '@ocso/application';
import { ChannelRuntime } from '@ocso/agent-runtime';
import type { ChannelRegistry, ConnectionCheckResult } from '@ocso/channels';
import { validation } from '@ocso/domain';
import { z } from 'zod';
import { Actor, RequireAnyPermission, RequirePermission } from '../../common/decorators.js';
import { CHANNEL_REGISTRY } from '../../infrastructure/tokens.js';

const Id = z.uuid();

/** Channel administration (design/04 Channels tab). Secrets are write-only. */
@Controller('v1/channels')
export class ChannelsAdminController {
  constructor(
    @Inject(ChannelService) private readonly channels: ChannelService,
    @Inject(CHANNEL_REGISTRY) private readonly registry: ChannelRegistry,
    @Inject(ChannelRuntime) private readonly runtime: ChannelRuntime,
  ) {}

  @Get()
  @RequirePermission(Permission.CHANNELS_READ)
  list() {
    return this.channels.list();
  }

  /**
   * Every registered kind's descriptor (docs/plugins/channels.md): the "Add
   * channel" form, the channel list, setup steps, and the marks and template
   * wording the workspace, agents and analytics show. Static plugin metadata
   * (no channel instances, no secrets), so every area that displays channels
   * may read it.
   */
  @Get('kinds')
  @RequireAnyPermission(Permission.CHANNELS_READ, Permission.CONVERSATIONS_READ, Permission.CONVERSATIONS_READ_TEAM, Permission.AGENTS_READ)
  kinds() {
    return this.registry.describeAll();
  }

  @Get(':id')
  @RequirePermission(Permission.CHANNELS_READ)
  get(@Param('id', { schema: Id }) id: string) {
    return this.channels.get(id);
  }

  @Post()
  @RequirePermission(Permission.CHANNELS_MANAGE)
  create(@Actor() actor: ActorContext, @Body({ schema: ChannelInput }) body: ChannelInput) {
    // Channel kinds are plugins: only kinds with a registered adapter can be created.
    if (!this.registry.has(body.kind)) throw validation('unknown_channel_kind', `kind: channel kind ${body.kind} is not available in this deployment`);
    return this.channels.create(actor, { ...body, secrets: this.withGeneratedSecrets(body.kind, body.secrets) });
  }

  /** Read-only provider check with the stored credentials (e.g. Twilio: fetch the account); never sends a message. */
  @Post(':id/test')
  @HttpCode(200)
  @RequirePermission(Permission.CHANNELS_MANAGE)
  async test(@Param('id', { schema: Id }) id: string): Promise<ConnectionCheckResult> {
    await this.channels.get(id);
    const { adapter, config } = await this.runtime.load(id);
    if (!adapter.checkConnection) throw validation('connection_check_unsupported', `${config.kind} channels have no connection check`);
    return adapter.checkConnection(config);
  }

  /** Secrets nobody needs to copy anywhere (e.g. the visitor token key) are generated when left empty. */
  private withGeneratedSecrets(kind: string, secrets: Record<string, string>): Record<string, string> {
    if (!this.registry.has(kind)) return secrets;
    const fields = this.registry.get(kind).describe().secrets;
    const generated = Object.fromEntries(fields.filter((f) => f.generate === 'server' && !secrets[f.key]).map((f) => [f.key, randomBytes(32).toString('base64url')]));
    return { ...generated, ...secrets };
  }

  @Patch(':id')
  @RequirePermission(Permission.CHANNELS_MANAGE)
  update(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: ChannelPatch }) body: ChannelPatch) {
    return this.channels.update(actor, id, body);
  }
}
