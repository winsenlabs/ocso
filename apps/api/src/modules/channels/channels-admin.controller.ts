import { randomBytes } from 'node:crypto';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Res } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import { ApprovalService, ChannelInput, ChannelPatch, ChannelService, WithApproval, requestStagedApproval, type ActorContext } from '@ocso/application';
import type { Response } from 'express';
import { ChannelRuntime } from '@ocso/agent-runtime';
import type { ChannelRegistry, ConnectionCheckResult } from '@ocso/channels';
import { validation } from '@ocso/domain';
import { z } from 'zod';
import { Actor, Capability, CurrentPrincipal, RequireAnyPermission, RequirePermission } from '../../common/decorators.js';
import { CHANNEL_REGISTRY } from '../../infrastructure/tokens.js';
import { approvalResponse } from '../approvals/approval-response.js';
import { createDraft, proposeOnly, withApprovalState, OptionalApproval, type ApprovalBody } from '../settings/platform-approvals.js';

const Id = z.uuid();
const CreateBody = ChannelInput.extend(WithApproval.shape);
type CreateBody = z.infer<typeof CreateBody>;
const PatchBody = ChannelPatch.extend(WithApproval.shape);
type PatchBody = z.infer<typeof PatchBody>;

/**
 * Channel administration (design/04 Channels tab). Secrets are write-only.
 * Maker–checker (PM/research/11 §4, approvals.check.channels): a channel is created as a draft; activating
 * (and resuming) is an ACTIVATE proposal, deleting a DELETE proposal, and once approved every edit is an
 * UPDATE proposal (202 with `approval`, else 409 approval_required). Disabling is immediate.
 */
@Controller('v1/channels')
export class ChannelsAdminController {
  constructor(
    @Inject(ChannelService) private readonly channels: ChannelService,
    @Inject(CHANNEL_REGISTRY) private readonly registry: ChannelRegistry,
    @Inject(ChannelRuntime) private readonly runtime: ChannelRuntime,
    @Inject(ApprovalService) private readonly approvals: ApprovalService,
  ) {}

  @Capability({ name: 'channels.list_channels', summary: 'List channels with their status and approval state.' })
  @Get()
  @RequirePermission(Permission.CHANNELS_READ)
  async list(@CurrentPrincipal() principal: Principal) {
    return withApprovalState(this.approvals, principal, 'channel', await this.channels.list());
  }

  /**
   * Every registered kind's descriptor (docs/plugins/channels.md): the "Add
   * channel" form, the channel list, setup steps, and the marks and template
   * wording the workspace, agents and analytics show. Static plugin metadata
   * (no channel instances, no secrets), so every area that displays channels
   * may read it.
   */
  @Capability({ name: 'channels.list_channel_kinds', summary: 'List the channel kinds this deployment supports.' })
  @Get('kinds')
  @RequireAnyPermission(Permission.CHANNELS_READ, Permission.CONVERSATIONS_READ, Permission.CONVERSATIONS_READ_TEAM, Permission.AGENTS_READ)
  kinds() {
    return this.registry.describeAll();
  }

  @Capability({ name: 'channels.get_channel', summary: "Get one channel's configuration and approval state (never its secrets)." })
  @Get(':id')
  @RequirePermission(Permission.CHANNELS_READ)
  async get(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string) {
    return (await withApprovalState(this.approvals, principal, 'channel', [await this.channels.get(id)]))[0];
  }

  /** A draft (201); `status: 'ACTIVE'` with `approval` also submits its activation (202 `{…channel, proposal}`). */
  @Capability({ exclude: 'may return a server-generated secret key once (web chat backend key); create channels on the Channels page' })
  @Post()
  @RequirePermission(Permission.CHANNELS_MANAGE)
  create(@Actor() actor: ActorContext, @Body({ schema: CreateBody }) body: CreateBody, @Res({ passthrough: true }) res: Response) {
    // Channel kinds are plugins: only kinds with a registered adapter can be created.
    if (!this.registry.has(body.kind)) throw validation('unknown_channel_kind', `kind: channel kind ${body.kind} is not available in this deployment`);
    const { approval, ...input } = body;
    return createDraft(res, {
      approvals: this.approvals,
      actor,
      kind: 'channel',
      live: input.status === 'ACTIVE',
      approval,
      create: async () => {
        const { secrets, revealed } = this.withGeneratedSecrets(input.kind, input.secrets);
        const channel = await this.channels.create(actor, { ...input, secrets });
        // Generated keys the admin must copy elsewhere (e.g. a backend secret key) are shown once, here only.
        return Object.keys(revealed).length ? { ...channel, revealedSecrets: revealed } : channel;
      },
    });
  }

  /** Always a proposal (DELETE): 202 `{proposal}` with `approval`, else 409 approval_required. */
  @Capability({ name: 'channels.delete_channel', summary: 'Delete a channel (always needs approval).' })
  @Delete(':id')
  @RequirePermission(Permission.CHANNELS_MANAGE)
  remove(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: OptionalApproval }) body: ApprovalBody, @Res({ passthrough: true }) res: Response) {
    return proposeOnly(res, this.approvals, actor, { kind: 'channel', id, action: 'DELETE' }, body?.approval);
  }

  /** Read-only provider check with the stored credentials (e.g. Twilio: fetch the account); never sends a message. */
  @Capability({ name: 'channels.test_channel', summary: "Check a channel's provider connection with its stored credentials (read-only).", risk: 'READ', tags: ['test', 'connection'] })
  @Post(':id/test')
  @HttpCode(200)
  @RequirePermission(Permission.CHANNELS_MANAGE)
  async test(@Param('id', { schema: Id }) id: string): Promise<ConnectionCheckResult> {
    await this.channels.get(id);
    const { adapter, config } = await this.runtime.load(id);
    if (!adapter.checkConnection) throw validation('connection_check_unsupported', `${config.kind} channels have no connection check`);
    return adapter.checkConnection(config);
  }

  /**
   * Server-generated secrets are filled in when left empty: ones nobody needs to copy (e.g. the visitor token
   * key) stay write-only; `reveal: 'once'` ones (e.g. a backend secret key) are also returned once to the creator.
   */
  private withGeneratedSecrets(kind: string, secrets: Record<string, string>): { secrets: Record<string, string>; revealed: Record<string, string> } {
    if (!this.registry.has(kind)) return { secrets, revealed: {} };
    const fields = this.registry.get(kind).describe().secrets.filter((f) => f.generate === 'server' && !secrets[f.key]);
    const generated = Object.fromEntries(fields.map((f) => [f.key, `${f.prefix ?? ''}${randomBytes(32).toString('base64url')}`]));
    const revealed = Object.fromEntries(fields.filter((f) => f.reveal === 'once').map((f) => [f.key, generated[f.key]!]));
    return { secrets: { ...generated, ...secrets }, revealed };
  }

  /**
   * `status: 'DISABLED'` stops the channel at once (never gated). `status: 'ACTIVE'` is an ACTIVATE proposal
   * (a draft's other fields are saved first; an approved channel's must come separately). Name, settings and
   * secrets: written directly on a draft, an UPDATE proposal once approved (new secrets travel as refs).
   */
  @Capability({ name: 'channels.update_channel', summary: "Change a channel's name or settings: disabling applies at once, activating needs approval.", stopWhen: { status: 'DISABLED' }, tags: ['disable'] })
  @Patch(':id')
  @RequirePermission(Permission.CHANNELS_MANAGE)
  async update(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: PatchBody }) body: PatchBody, @Res({ passthrough: true }) res: Response) {
    const { approval, status, ...edit } = body;
    const hasEdit = Object.values(edit).some((v) => v !== undefined);
    if (status === 'DISABLED') await this.channels.disable(actor, id);
    if (status === 'ACTIVE') {
      if (hasEdit) {
        const state = await this.approvals.objectState(actor.principal!, 'channel', id);
        if (state.approved) throw validation('activate_alone', 'Resume the channel on its own; change its settings in a separate request.');
        await this.channels.update(actor, id, edit);
      }
      return proposeOnly(res, this.approvals, actor, { kind: 'channel', id, action: 'ACTIVATE' }, approval);
    }
    if (status === 'DRAFT' && (await this.approvals.objectState(actor.principal!, 'channel', id)).approved) {
      throw validation('channel_not_draft', 'An approved channel cannot return to draft; disable it instead.');
    }
    if (!hasEdit) return this.channels.get(id);
    return approvalResponse(
      res,
      requestStagedApproval(this.approvals, actor, { objectKind: 'channel', objectId: id, action: 'UPDATE' }, approval, () => this.channels.update(actor, id, edit), () => this.channels.stageChange(actor, id, edit)),
    );
  }
}
