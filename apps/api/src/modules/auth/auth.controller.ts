import { Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { permissionsForRole, type Principal } from '@ocso/auth';
import { SessionService, SettingsService, SetupInput, SetupService, type ActorContext } from '@ocso/application';
import { z } from 'zod';
import { Actor, Authenticated, CurrentPrincipal, Public, type OcsoRequest } from '../../common/decorators.js';

const LoginInput = z.object({ email: z.email().max(320), password: z.string().min(1).max(256) });
type LoginInput = z.infer<typeof LoginInput>;

/**
 * Session API used by the Next.js BFF (ADR-020). The BFF stores the returned
 * token in an httpOnly cookie; browsers never see it.
 */
@Controller('v1')
export class AuthController {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(SetupService) private readonly setup: SetupService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  @Post('auth/login')
  @Public()
  @HttpCode(200)
  async login(@Body({ schema: LoginInput }) body: LoginInput, @Req() req: OcsoRequest) {
    const session = await this.sessions.login(body.email, body.password, {
      ip: req.ip,
      userAgent: req.header('user-agent'),
      correlationId: req.correlationId ?? 'login',
    });
    return { token: session.token, expiresAt: session.expiresAt.toISOString(), user: await this.describe(session.principal) };
  }

  @Post('auth/logout')
  @Authenticated()
  @HttpCode(204)
  async logout(@Req() req: OcsoRequest, @Actor() actor: ActorContext): Promise<void> {
    if (req.sessionToken) await this.sessions.logout(req.sessionToken, actor);
  }

  @Get('auth/me')
  @Authenticated()
  me(@CurrentPrincipal() principal: Principal) {
    return this.describe(principal);
  }

  @Get('setup/status')
  @Public()
  async setupStatus() {
    const settings = await this.settings.deployment();
    return { setupRequired: await this.setup.isSetupRequired(), orgName: settings.orgName };
  }

  @Post('setup')
  @Public()
  @HttpCode(201)
  async completeSetup(@Body({ schema: SetupInput }) body: SetupInput, @Req() req: OcsoRequest) {
    await this.setup.complete(body, req.correlationId ?? 'setup');
    return { ok: true };
  }

  private async describe(principal: Principal) {
    const settings = await this.settings.deployment();
    return {
      id: principal.userId,
      name: principal.displayName,
      role: principal.role,
      teamIds: principal.teamIds,
      permissions: permissionsForRole(principal.role),
      deployment: { orgName: settings.orgName, label: settings.deploymentLabel, region: settings.regionLabel, timezone: settings.timezone },
    };
  }
}
