import { Permission, assertCan } from '@ocso/auth';
import { uuidv7 } from '@ocso/db';
import { EmailSendError, describeRecipients, renderLayout, type EmailErrorCategory, type EmailSender, type EmailStatus } from '@ocso/email';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import type { ActorContext, Db } from '../shared/context.js';
import { SettingsService } from './settings.js';

export const EmailTestInput = z.object({ to: z.email().max(320) });
export type EmailTestInput = z.infer<typeof EmailTestInput>;

export interface EmailTestResult {
  ok: boolean;
  driver: EmailStatus['driver'];
  /** The driver's display name (e.g. `Resend`). */
  label: string;
  /** False when the driver never hands messages to anyone (log): a "sent" test reached nobody. */
  delivers: boolean;
  /** Provider message id (Resend id / SMTP Message-ID) when sent. */
  id: string | null;
  error?: string;
  category?: EmailErrorCategory;
  retriable?: boolean;
  /** Set for a non-delivering driver: the message was only written to the server log. */
  warning?: string;
}

/**
 * Read-only view of the deployment email configuration (bootstrap env, never
 * the database) plus a test send for the Tech admin. The view is
 * secret-free by construction (EmailStatus has no credential fields).
 */
export class EmailSettingsService {
  private readonly settings: SettingsService;

  constructor(
    private readonly db: Db,
    private readonly sender: EmailSender,
    private readonly statusView: EmailStatus,
  ) {
    this.settings = new SettingsService(db);
  }

  status(actor: ActorContext): EmailStatus {
    assertCan(actor.principal!, Permission.DEPLOYMENT_SETTINGS_MANAGE);
    return { ...this.statusView, warnings: [...this.statusView.warnings] };
  }

  /** Send one test email with the deployment sender; audited, never throws for provider failures. */
  async sendTest(actor: ActorContext, input: EmailTestInput): Promise<EmailTestResult> {
    assertCan(actor.principal!, Permission.DEPLOYMENT_SETTINGS_MANAGE);
    const org = (await this.settings.deployment()).orgName;
    const rendered = renderLayout({
      org,
      subject: 'OCSO test email',
      heading: 'Email delivery works',
      preheader: 'Test message from your OCSO deployment.',
      blocks: [
        { kind: 'text', text: `${actor.principal?.displayName ?? 'A Tech admin'} sent this test from the OCSO Settings page to check the deployment's email configuration.` },
        { kind: 'facts', rows: [['Driver', this.sender.driver], ['From', this.sender.from]] },
        { kind: 'note', text: 'No action is needed.' },
      ],
    });
    let result: EmailTestResult;
    const driver = { driver: this.sender.driver, label: this.statusView.label, delivers: this.sender.delivers !== false };
    try {
      const sent = await this.sender.send({ to: input.to, ...rendered, tags: { kind: 'test' }, idempotencyKey: `email-test/${uuidv7()}` });
      result = { ok: true, ...driver, id: sent.id };
      if (!driver.delivers) result.warning = `${driver.label} driver: the message was written to the server log, nothing was delivered.`;
    } catch (error) {
      result =
        error instanceof EmailSendError
          ? { ok: false, ...driver, id: null, error: error.message, category: error.category, retriable: error.retriable }
          : { ok: false, ...driver, id: null, error: 'email send failed', category: 'unknown', retriable: true };
    }
    await recordAudit(this.db, actor, {
      action: 'email.test_send',
      targetType: 'deployment',
      summary: `Test email (${this.sender.driver}) to ${describeRecipients(input.to)}: ${result.ok ? 'sent' : `failed (${result.category ?? 'unknown'})`}`,
      after: { to: input.to, driver: this.sender.driver, ok: result.ok, category: result.category ?? null, providerId: result.id },
    });
    return result;
  }
}
