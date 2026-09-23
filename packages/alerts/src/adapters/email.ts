import { alertEmail, EmailSendError, type EmailSender } from '@ocso/email';
import { z } from 'zod';
import { checkConfig } from '../config-check.js';
import { delivered, failed, type AlertDeliveryAdapter, type AlertMessage, type DeliveryResult, type SecretRequirement } from '../contract.js';
import { DEFAULT_TIMEOUT_MS, redactSecrets } from '../http.js';
import { renderAlert, severityTag } from '../render.js';
import type { DeliveryAdapterDeps } from './deps.js';
import { classifySmtpError, type OutgoingMail } from './email-transport.js';

const Recipients = z.array(z.email().max(320)).min(1).max(50).meta({ title: 'Recipients' });
const transport = <T extends string>(value: T) => z.literal(value).meta({ title: 'Send with' });

/** `deployment`: the server's own sender (EMAIL_DRIVER — Resend, SMTP or log). No per-destination credentials. */
const DeploymentEmailConfig = z.object({ transport: transport('deployment'), to: Recipients }).strict().meta({ title: "This server's email (EMAIL_DRIVER)" });

/** `smtp`: a relay configured on this destination (password in the SecretStore). */
const SmtpFields = {
  transport: transport('smtp'),
  to: Recipients,
  host: z.string().trim().min(1).max(253).meta({ title: 'SMTP host' }),
  port: z.number().int().min(1).max(65_535).default(587).meta({ title: 'Port', description: '587 STARTTLS · 465 implicit TLS' }),
  from: z.email().max(320).meta({ title: 'From address' }),
  /** SMTP user; defaults to `from` when a password secret is configured. */
  username: z.string().trim().min(1).max(320).optional().meta({ title: 'SMTP user', description: 'defaults to the from address' }),
  /** Require STARTTLS on non-implicit-TLS ports. Disable only for local relays. */
  requireTLS: z.boolean().default(true).meta({ title: 'Require TLS', description: 'disable only for local relays' }),
};
const SmtpEmailConfig = z
  .object({
    ...SmtpFields,
    /** Implicit TLS; defaults to true on port 465. API-only: the form derives it from the port. */
    secure: z.boolean().optional(),
  })
  .strict()
  .transform((c) => ({ ...c, secure: c.secure ?? c.port === 465 }));

/**
 * Configs saved before `transport` existed carry SMTP settings and stay SMTP;
 * new destinations without SMTP settings default to the deployment sender.
 */
const EmailConfig = z.preprocess(
  (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || 'transport' in input) return input;
    return { ...input, transport: 'host' in input ? 'smtp' : 'deployment' };
  },
  z.union([DeploymentEmailConfig, SmtpEmailConfig]),
);
export type EmailConfig = z.output<typeof EmailConfig>;
export type SmtpEmailConfig = Extract<EmailConfig, { transport: 'smtp' }>;

/** The admin form: one branch per transport (`oneOf` pinned by `transport`). */
const EmailForm = z.discriminatedUnion('transport', [DeploymentEmailConfig, z.object(SmtpFields).strict().meta({ title: 'Your own SMTP relay' })]);

const SMTP_SECRET: SecretRequirement = {
  required: false,
  secretKind: 'OTHER',
  label: 'SMTP password',
  description: 'SMTP password (omit for unauthenticated relays)',
  when: { transport: 'smtp' },
};

/** Email delivery through the deployment sender (default) or a per-destination SMTP relay. */
export function createEmailAdapter(deps: Pick<DeliveryAdapterDeps, 'mailTransport' | 'timeoutMs' | 'emailSender'>): AlertDeliveryAdapter<EmailConfig> {
  return {
    kind: 'EMAIL',
    label: 'Email',
    description: "Emails the recipients through this server's email (EMAIL_DRIVER) or your own SMTP relay.",
    events: ['OPENED', 'RESOLVED', 'REMINDER'],
    configSchema: z.toJSONSchema(EmailForm, { io: 'input' }) as Record<string, unknown>,
    secret: SMTP_SECRET,
    validateConfig: (config) => checkConfig(EmailConfig, config),
    validateSecret: () => [],
    summary: (config) => `${config.to.join(', ')} via ${config.transport === 'smtp' ? config.host : 'deployment email'}`,
    async deliver(message, config, secret) {
      if (config.transport === 'deployment') return sendWithDeployment(deps.emailSender ?? null, message, config.to);
      const transport = deps.mailTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        requireTLS: config.requireTLS,
        auth: secret ? { user: config.username ?? config.from, pass: secret } : undefined,
        timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      try {
        const info = await transport.sendMail(buildMail(message, config));
        return delivered(info.messageId);
      } catch (error) {
        const classified = classifySmtpError(error);
        return failed(classified.retriable, redactSecrets(classified.error, [secret]));
      } finally {
        transport.close();
      }
    },
  };
}

/** Deployment sender: idempotent per delivery, so queue retries never send twice (Resend). */
async function sendWithDeployment(sender: EmailSender | null, message: AlertMessage, to: readonly string[]): Promise<DeliveryResult> {
  if (!sender) return failed(false, 'deployment email sender is not available');
  const rendered = renderAlertEmail(message);
  try {
    const result = await sender.send({
      to,
      ...rendered,
      tags: { kind: 'alert', event: message.event, severity: message.severity },
      idempotencyKey: `alert-delivery/${message.deliveryId}`,
    });
    return delivered(result.id ?? undefined);
  } catch (error) {
    if (error instanceof EmailSendError) return failed(error.retriable, error.message);
    return failed(true, 'email send failed');
  }
}

/** Subject, HTML and text for an alert (shared layout from @ocso/email). */
export function renderAlertEmail(message: AlertMessage): { subject: string; html: string; text: string } {
  const r = renderAlert(message);
  return alertEmail({
    org: message.deployment ?? 'OCSO',
    title: message.title,
    severity: severityTag(message),
    summary: r.body,
    fields: r.fields.map((f) => [f.label, f.value] as const),
    link: r.link,
    reference: `Alert ${message.alertId}`,
  });
}

export function buildMail(message: AlertMessage, config: { from: string; to: readonly string[] }): OutgoingMail {
  return {
    from: config.from,
    to: [...config.to],
    ...renderAlertEmail(message),
    headers: {
      'X-OCSO-Alert-Id': message.alertId,
      'X-OCSO-Alert-Event': message.event,
      'X-OCSO-Alert-Severity': message.severity,
    },
  };
}
