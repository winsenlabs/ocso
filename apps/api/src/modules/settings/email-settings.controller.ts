import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import { EmailSettingsService, EmailTestInput, type ActorContext } from '@ocso/application';
import { Actor, RequirePermission } from '../../common/decorators.js';

/**
 * Deployment email, read-only (docs/operations/compose.md#email): email is
 * auth-critical, so it is configured by the deployment (EMAIL_* env and
 * secret files), never from the UI. The view never contains credentials.
 */
@Controller('v1/settings/email')
export class EmailSettingsController {
  constructor(@Inject(EmailSettingsService) private readonly email: EmailSettingsService) {}

  /** Driver, from, reply-to, configured yes/no and warnings. */
  @Get()
  @RequirePermission(Permission.DEPLOYMENT_SETTINGS_MANAGE)
  status(@Actor() actor: ActorContext) {
    return this.email.status(actor);
  }

  /** Send a test email with the deployment sender; returns ok or the error category. Audited. */
  @Post('test')
  @HttpCode(200)
  @RequirePermission(Permission.DEPLOYMENT_SETTINGS_MANAGE)
  test(@Actor() actor: ActorContext, @Body({ schema: EmailTestInput }) body: EmailTestInput) {
    return this.email.sendTest(actor, body);
  }
}
