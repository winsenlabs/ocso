import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import { ApprovalService, AuthPolicyInput, AuthPolicyService, SETTINGS_OBJECT_ID, WithApproval, requestApproval, type ActorContext } from '@ocso/application';
import { SsoProviderInput, SsoProviderPatch, SsoProviderService } from '@ocso/application/auth-server';
import type { Response } from 'express';
import { z } from 'zod';
import { Actor, CurrentPrincipal, RequirePermission, type OcsoRequest } from '../../common/decorators.js';
import { approvalResponse } from '../approvals/approval-response.js';
import { createDraft, proposeOnly, withApprovalState, OptionalApproval, type ApprovalBody } from '../settings/platform-approvals.js';

const PolicyBody = AuthPolicyInput.extend(WithApproval.shape);
type PolicyBody = z.infer<typeof PolicyBody>;
const PatchBody = SsoProviderPatch.extend(WithApproval.shape);
type PatchBody = z.infer<typeof PatchBody>;
const StatusBody = WithApproval.extend({ status: z.enum(['ACTIVE', 'DISABLED']) });
type StatusBody = z.infer<typeof StatusBody>;

const ProviderId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
const actingSession = (req: OcsoRequest) => ({ headers: new Headers({ authorization: `Bearer ${req.authSession?.bearer ?? ''}` }) });

/**
 * Authentication settings for the Tech admin (ADR-025): which roles
 * must use MFA, and the SSO identity providers. Secrets are write-only.
 *
 * Maker–checker (PM/research/11 §4, approvals.check.platform): the MFA policy is part of the deployment
 * settings (every change a proposal on the settings singleton). An SSO provider is registered as a draft
 * (sign-in refused); activating and re-enabling are ACTIVATE proposals, deleting a DELETE proposal, and once
 * approved every edit is an UPDATE proposal. Disabling is immediate.
 */
@Controller('v1/settings')
export class AuthSettingsController {
  constructor(
    @Inject(AuthPolicyService) private readonly policy: AuthPolicyService,
    @Inject(SsoProviderService) private readonly sso: SsoProviderService,
    @Inject(ApprovalService) private readonly approvals: ApprovalService,
  ) {}

  @Get('auth-policy')
  @RequirePermission(Permission.DEPLOYMENT_SETTINGS_MANAGE)
  getPolicy() {
    return this.policy.get();
  }

  @Put('auth-policy')
  @RequirePermission(Permission.DEPLOYMENT_SETTINGS_MANAGE)
  updatePolicy(@Actor() actor: ActorContext, @Body({ schema: PolicyBody }) body: PolicyBody, @Res({ passthrough: true }) res: Response) {
    const { approval, ...mfa } = body;
    return approvalResponse(res, requestApproval(this.approvals, actor, { objectKind: 'deployment_settings', objectId: SETTINGS_OBJECT_ID, action: 'UPDATE', payload: { mfa } }, approval, null));
  }

  @Get('sso-providers')
  @RequirePermission(Permission.DEPLOYMENT_SETTINGS_MANAGE)
  async listProviders(@Actor() actor: ActorContext, @CurrentPrincipal() principal: Principal) {
    return withApprovalState(this.approvals, principal, 'sso_provider', await this.sso.list(actor));
  }

  /** Registered as a draft (201); `approval` in the body also submits its activation (202). */
  @Post('sso-providers')
  @RequirePermission(Permission.DEPLOYMENT_SETTINGS_MANAGE)
  createProvider(@Actor() actor: ActorContext, @Body({ schema: SsoProviderInput.and(WithApproval) }) body: SsoProviderInput & ApprovalBody, @Req() req: OcsoRequest, @Res({ passthrough: true }) res: Response) {
    const { approval, ...input } = body;
    return createDraft(res, { approvals: this.approvals, actor, kind: 'sso_provider', live: approval !== undefined, approval, create: () => this.sso.create(actor, input as SsoProviderInput, actingSession(req)) });
  }

  @Patch('sso-providers/:providerId')
  @RequirePermission(Permission.DEPLOYMENT_SETTINGS_MANAGE)
  async updateProvider(@Actor() actor: ActorContext, @Param('providerId', { schema: ProviderId }) providerId: string, @Body({ schema: PatchBody }) body: PatchBody, @Res({ passthrough: true }) res: Response) {
    const { approval, ...patch } = body;
    const id = await this.sso.objectId(actor, providerId);
    return approvalResponse(res, requestApproval(this.approvals, actor, { objectKind: 'sso_provider', objectId: id, action: 'UPDATE', payload: patch }, approval, () => this.sso.update(actor, providerId, patch)));
  }

  /** DISABLED stops sign-in through it at once; ACTIVE (activate or re-enable) is an ACTIVATE proposal. */
  @Post('sso-providers/:providerId/status')
  @RequirePermission(Permission.DEPLOYMENT_SETTINGS_MANAGE)
  async setProviderStatus(@Actor() actor: ActorContext, @Param('providerId', { schema: ProviderId }) providerId: string, @Body({ schema: StatusBody }) body: StatusBody, @Res({ passthrough: true }) res: Response) {
    if (body.status === 'DISABLED') return this.sso.disable(actor, providerId);
    return proposeOnly(res, this.approvals, actor, { kind: 'sso_provider', id: await this.sso.objectId(actor, providerId), action: 'ACTIVATE' }, body?.approval);
  }

  /** Always a proposal (DELETE): 202 `{proposal}` with `approval`, else 409 approval_required. */
  @Delete('sso-providers/:providerId')
  @RequirePermission(Permission.DEPLOYMENT_SETTINGS_MANAGE)
  async deleteProvider(@Actor() actor: ActorContext, @Param('providerId', { schema: ProviderId }) providerId: string, @Body({ schema: OptionalApproval }) body: ApprovalBody, @Res({ passthrough: true }) res: Response) {
    return proposeOnly(res, this.approvals, actor, { kind: 'sso_provider', id: await this.sso.objectId(actor, providerId), action: 'DELETE' }, body?.approval);
  }
}
