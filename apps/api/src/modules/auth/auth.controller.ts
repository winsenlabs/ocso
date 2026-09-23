import { Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { permissionsForRole, type Principal } from '@ocso/auth';
import { RecoveryInput, RecoveryService, SettingsService, SetupInput, SetupService, hasPasswordCredential, loadPrincipal } from '@ocso/application';
import { SsoProviderService, type AuthServer } from '@ocso/application/auth-server';
import type { ApiEnv } from '@ocso/config';
import type { Db } from '@ocso/db';
import { DomainError } from '@ocso/domain';
import { z } from 'zod';
import { Authenticated, CurrentPrincipal, Public, type OcsoRequest } from '../../common/decorators.js';
import { AUTH, DB, ENV } from '../../infrastructure/tokens.js';
import { authErrorFrom, callAuthEndpoint } from './auth-bridge.js';

const LoginInput = z.object({ email: z.email().max(320), password: z.string().min(1).max(256) });
type LoginInput = z.infer<typeof LoginInput>;

/**
 * Session API (ADR-020, ADR-025). Browsers and the web BFF authenticate with
 * Better Auth at /api/auth/*; these /v1 routes describe the signed-in user,
 * run first-run setup and break-glass recovery, and keep a JSON sign-in for
 * API clients (scripts, tests) that goes through Better Auth unchanged.
 */
@Controller('v1')
export class AuthController {
  constructor(
    @Inject(AUTH) private readonly auth: AuthServer,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(DB) private readonly db: Db,
    @Inject(SetupService) private readonly setup: SetupService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(RecoveryService) private readonly recovery: RecoveryService,
    @Inject(SsoProviderService) private readonly sso: SsoProviderService,
  ) {}

  /**
   * Better Auth's /sign-in/email (same rate limits, throttling and audit),
   * answering with the bearer token instead of a cookie. Accounts with two-factor
   * authentication must sign in through the web app.
   */
  @Post('auth/login')
  @Public()
  @HttpCode(200)
  async login(@Body({ schema: LoginInput }) body: LoginInput, @Req() req: OcsoRequest) {
    const res = await callAuthEndpoint(this.auth, this.env.OCSO_PUBLIC_URL, '/sign-in/email', req, body);
    if (!res.ok) throw await authErrorFrom(res);
    const token = res.headers.get('set-auth-token');
    const payload = (await res.json().catch(() => ({}))) as { twoFactorRedirect?: boolean };
    if (payload.twoFactorRedirect || !token) {
      throw new DomainError('authentication', 'mfa_required', 'This account uses two-factor authentication: sign in through the OCSO web app');
    }
    const session = await this.auth.getSession(new Headers({ authorization: `Bearer ${token}` }));
    const principal = session ? await loadPrincipal(this.db, session.user.id, 'API') : null;
    if (!session || !principal) throw new DomainError('authentication', 'invalid_credentials', 'Invalid email or password');
    return { token, expiresAt: session.session.expiresAt.toISOString(), user: await this.describe(principal) };
  }

  @Post('auth/logout')
  @Authenticated({ allowPendingMfa: true })
  @HttpCode(204)
  async logout(@Req() req: OcsoRequest): Promise<void> {
    if (req.authSession) await this.auth.signOut(new Headers({ authorization: `Bearer ${req.authSession.bearer}` }));
  }

  @Get('auth/me')
  @Authenticated({ allowPendingMfa: true })
  async me(@CurrentPrincipal() principal: Principal, @Req() req: OcsoRequest) {
    return {
      ...(await this.describe(principal)),
      session: req.authSession ? { id: req.authSession.id, method: req.authSession.authMethod, expiresAt: req.authSession.expiresAt.toISOString() } : null,
      mfa: req.authSession?.mfa ?? { required: false, satisfied: false, enrolled: false },
    };
  }

  /** Facts for Account security and forced MFA enrolment (sessions, passkeys and 2FA come from Better Auth). */
  @Get('auth/security')
  @Authenticated({ allowPendingMfa: true })
  async security(@CurrentPrincipal() principal: Principal, @Req() req: OcsoRequest) {
    return { hasPassword: await hasPasswordCredential(this.db, principal.userId), mfa: req.authSession?.mfa ?? null, sessionId: req.authSession?.id ?? null };
  }

  @Get('setup/status')
  @Public()
  async setupStatus() {
    const settings = await this.settings.deployment();
    return { setupRequired: await this.setup.isSetupRequired(), orgName: settings.orgName, sso: await this.sso.anyConfigured(), recovery: this.recovery.enabled };
  }

  @Post('setup')
  @Public()
  @HttpCode(201)
  async completeSetup(@Body({ schema: SetupInput }) body: SetupInput, @Req() req: OcsoRequest) {
    await this.setup.complete(body, req.correlationId ?? 'setup');
    return { ok: true };
  }

  /** Break-glass recovery (ADR-025): only while OCSO_RECOVERY_TOKEN is set; each token value works once. */
  @Post('setup/recover')
  @Public()
  @HttpCode(200)
  async recover(@Body({ schema: RecoveryInput }) body: RecoveryInput, @Req() req: OcsoRequest) {
    await this.recovery.recover(body, { correlationId: req.correlationId ?? 'recovery', ip: req.header('x-ocso-client-ip') ?? req.ip });
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
