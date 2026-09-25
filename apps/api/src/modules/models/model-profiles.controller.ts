import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Res } from '@nestjs/common';
import { Permission, can, type Principal } from '@ocso/auth';
import { ApprovalService, ProfileInput, ProfilePatch, ProfileService, WithApproval, requestApproval, type ActorContext } from '@ocso/application';
import type { Response } from 'express';
import { z } from 'zod';
import { Actor, Authenticated, Capability, CurrentPrincipal, RequirePermission } from '../../common/decorators.js';
import { approvalResponse } from '../approvals/approval-response.js';
import { proposeOnly, withApprovalState, OptionalApproval, type ApprovalBody } from '../settings/platform-approvals.js';

const PatchBody = ProfilePatch.extend(WithApproval.shape);
type PatchBody = z.infer<typeof PatchBody>;

/**
 * Logical model profiles (docs/archive/specs/06 §2). Maker–checker (PM/research/11 §4, approvals.check.platform): a profile
 * nothing live uses and never approved is a draft, edited directly; `POST :id/activate` approves it for use;
 * once approved or in use by something live every edit is an UPDATE proposal; deleting is a DELETE proposal.
 */
@Controller('v1/model-profiles')
export class ModelProfilesController {
  constructor(
    @Inject(ProfileService) private readonly profiles: ProfileService,
    @Inject(ApprovalService) private readonly approvals: ApprovalService,
  ) {}

  /** providers.read OR agents.read (Leads pick profiles for agents); checked in the service. */
  @Capability({ name: 'models.list_profiles', summary: 'List model profiles (the model, settings and fallbacks an agent uses).', tags: ['profile'] })
  @Get()
  @Authenticated()
  async list(@Actor() actor: ActorContext, @CurrentPrincipal() principal: Principal) {
    const rows = await this.profiles.list(actor);
    return can(principal, Permission.PROVIDERS_READ) ? withApprovalState(this.approvals, principal, 'model_profile', rows) : rows;
  }

  /** Dry-run policy check for the profile dialog (residency, allowlist, fallback rules). */
  @Capability({ name: 'models.validate_profile', summary: 'Check a model profile against policy (residency, allowlist, fallbacks) without saving it.', risk: 'READ', tags: ['profile', 'check'] })
  @Post('validate')
  @HttpCode(200)
  @RequirePermission(Permission.MODEL_PROFILES_MANAGE)
  validate(@Actor() actor: ActorContext, @Body({ schema: ProfileInput }) body: ProfileInput) {
    return this.profiles.validate(actor, body);
  }

  @Capability({ name: 'models.get_profile', summary: 'Get one model profile.', tags: ['profile'] })
  @Get(':id')
  @Authenticated()
  async get(@Actor() actor: ActorContext, @CurrentPrincipal() principal: Principal, @Param('id', { schema: z.uuid() }) id: string) {
    const row = await this.profiles.get(actor, id);
    return can(principal, Permission.PROVIDERS_READ) ? (await withApprovalState(this.approvals, principal, 'model_profile', [row]))[0] : row;
  }

  @Capability({ name: 'models.create_profile', summary: 'Create a model profile as a draft (approving it for use needs approval).', tags: ['profile'] })
  @Post()
  @RequirePermission(Permission.MODEL_PROFILES_MANAGE)
  create(@Actor() actor: ActorContext, @Body({ schema: ProfileInput }) body: ProfileInput) {
    return this.profiles.create(actor, body);
  }

  @Capability({ name: 'models.update_profile', summary: "Change a model profile (an approved profile's change needs approval).", tags: ['profile'] })
  @Patch(':id')
  @RequirePermission(Permission.MODEL_PROFILES_MANAGE)
  update(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: PatchBody }) body: PatchBody, @Res({ passthrough: true }) res: Response) {
    const { approval, ...patch } = body;
    return approvalResponse(res, requestApproval(this.approvals, actor, { objectKind: 'model_profile', objectId: id, action: 'UPDATE', payload: patch }, approval, () => this.profiles.update(actor, id, patch)));
  }

  /** "Approve for use": always a proposal (ACTIVATE). */
  @Capability({ name: 'models.activate_profile', summary: 'Approve a model profile for use (always needs approval).', tags: ['profile'] })
  @Post(':id/activate')
  @HttpCode(202)
  @RequirePermission(Permission.MODEL_PROFILES_MANAGE)
  activate(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: OptionalApproval }) body: ApprovalBody, @Res({ passthrough: true }) res: Response) {
    return proposeOnly(res, this.approvals, actor, { kind: 'model_profile', id, action: 'ACTIVATE' }, body?.approval);
  }

  /** Always a proposal (DELETE): 202 `{proposal}` with `approval`, else 409 approval_required. */
  @Capability({ name: 'models.delete_profile', summary: 'Delete a model profile (always needs approval).', tags: ['profile'] })
  @Delete(':id')
  @RequirePermission(Permission.MODEL_PROFILES_MANAGE)
  remove(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: OptionalApproval }) body: ApprovalBody, @Res({ passthrough: true }) res: Response) {
    return proposeOnly(res, this.approvals, actor, { kind: 'model_profile', id, action: 'DELETE' }, body?.approval);
  }
}
