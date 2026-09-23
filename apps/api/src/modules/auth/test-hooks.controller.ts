import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import type { ApiEnv } from '@ocso/config';
import { notFound } from '@ocso/domain';
import { LogEmailSender, type EmailSender } from '@ocso/email';
import { z } from 'zod';
import { RequirePermission } from '../../common/decorators.js';
import { EMAIL_SENDER, ENV } from '../../infrastructure/tokens.js';

const EmailsQuery = z.object({ to: z.email().max(320) });
type EmailsQuery = z.infer<typeof EmailsQuery>;

/**
 * Test-only: emails the log driver captured, so end-to-end tests can follow
 * invite and password-reset links. Answers 404 unless OCSO_ENABLE_TEST_HOOKS
 * is on (refused in production at start-up), and only for a Tech Admin.
 */
@Controller('v1/test-hooks')
export class TestHooksController {
  constructor(
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
  ) {}

  @Get('emails')
  @RequirePermission(Permission.SYSTEM_CONFIGURE)
  emails(@Query({ schema: EmailsQuery }) q: EmailsQuery) {
    if (!this.env.OCSO_ENABLE_TEST_HOOKS || this.env.NODE_ENV === 'production' || !(this.sender instanceof LogEmailSender)) throw notFound('route', 'test-hooks');
    const to = q.to.toLowerCase();
    return this.sender.sent
      .filter((m) => [m.to].flat().some((address) => address.toLowerCase() === to))
      .map((m) => ({ to: m.to, subject: m.subject, text: m.text, kind: m.tags?.['kind'] ?? null }));
  }
}
