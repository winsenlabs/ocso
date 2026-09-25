import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import { EmailSettingsService, EmailTestInput, type ActorContext } from '@ocso/application';
import { Actor, Capability, RequirePermission } from '../../common/decorators.js';

/**
 * Deployment email, read-only (docs/guides/email.md): email is
 * auth-critical, so it is configured by the deployment (EMAIL_* env and
 * secret files), never from the UI. The view never contains credentials.
 */
@Controller('v1/settings/email')
export class EmailSettingsController {
  constructor(@Inject(EmailSettingsService) private readonly email: EmailSettingsService) {}

  /** Driver, from, reply-to, configured yes/no and warnings. */
  @Capability({ name: 'settings.get_email_status', summary: 'Email sending status: driver, sender, whether it is configured, warnings.', tags: ['email'] })
  @Get()
  @RequirePermission(Permission.DEPLOYMENT_SETTINGS_MANAGE)
  status(@Actor() actor: ActorContext) {
    return this.email.status(actor);
  }

  /** Send a test email with the deployment sender; returns ok or the error category. Audited. */
  @Capability({ name: 'settings.send_test_email', summary: 'Send a test email from the deployment sender.', risk: 'LOW_WRITE', tags: ['email', 'test'] })
  @Post('test')
  @HttpCode(200)
  @RequirePermission(Permission.DEPLOYMENT_SETTINGS_MANAGE)
  test(@Actor() actor: ActorContext, @Body({ schema: EmailTestInput }) body: EmailTestInput) {
    return this.email.sendTest(actor, body);
  }
}
