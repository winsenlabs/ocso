import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import { AuthPolicyInput, AuthPolicyService, type ActorContext } from '@ocso/application';
import { SsoProviderInput, SsoProviderPatch, SsoProviderService } from '@ocso/application/auth-server';
import { z } from 'zod';
import { Actor, RequirePermission, type OcsoRequest } from '../../common/decorators.js';

const ProviderId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
const actingSession = (req: OcsoRequest) => ({ headers: new Headers({ authorization: `Bearer ${req.authSession?.bearer ?? ''}` }) });

/**
 * Authentication settings for the Tech admin (ADR-025): which roles
 * must use MFA, and the SSO identity providers. Secrets are write-only.
 */
@Controller('v1/settings')
export class AuthSettingsController {
  constructor(
    @Inject(AuthPolicyService) private readonly policy: AuthPolicyService,
    @Inject(SsoProviderService) private readonly sso: SsoProviderService,
  ) {}

  @Get('auth-policy')
  @RequirePermission(Permission.DEPLOYMENT_SETTINGS_MANAGE)
  getPolicy() {
    return this.policy.get();
  }

  @Put('auth-policy')
  @RequirePermission(Permission.DEPLOYMENT_SETTINGS_MANAGE)
  updatePolicy(@Actor() actor: ActorContext, @Body({ schema: AuthPolicyInput }) body: AuthPolicyInput) {
    return this.policy.update(actor, body);
  }

  @Get('sso-providers')
  @RequirePermission(Permission.DEPLOYMENT_SETTINGS_MANAGE)
  listProviders(@Actor() actor: ActorContext) {
    return this.sso.list(actor);
  }

  @Post('sso-providers')
  @RequirePermission(Permission.DEPLOYMENT_SETTINGS_MANAGE)
  createProvider(@Actor() actor: ActorContext, @Body({ schema: SsoProviderInput }) body: SsoProviderInput, @Req() req: OcsoRequest) {
    return this.sso.create(actor, body, actingSession(req));
  }

  @Patch('sso-providers/:providerId')
  @RequirePermission(Permission.DEPLOYMENT_SETTINGS_MANAGE)
  updateProvider(@Actor() actor: ActorContext, @Param('providerId', { schema: ProviderId }) providerId: string, @Body({ schema: SsoProviderPatch }) body: SsoProviderPatch) {
    return this.sso.update(actor, providerId, body);
  }

  @Delete('sso-providers/:providerId')
  @RequirePermission(Permission.DEPLOYMENT_SETTINGS_MANAGE)
  @HttpCode(204)
  async deleteProvider(@Actor() actor: ActorContext, @Param('providerId', { schema: ProviderId }) providerId: string, @Req() req: OcsoRequest): Promise<void> {
    await this.sso.remove(actor, providerId, actingSession(req));
  }
}
