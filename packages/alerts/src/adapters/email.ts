import { alertEmail, EmailSendError, type EmailSender } from '@ocso/email';
import { z } from 'zod';
import { checkConfig } from '../config-check.js';
import { delivered, failed, type AlertDeliveryAdapter, type AlertMessage, type DeliveryResult, type SecretRequirement } from '../contract.js';
import { DEFAULT_TIMEOUT_MS, redactSecrets } from '../http.js';
import { renderAlert, severityTag } from '../render.js';
import type { DeliveryAdapterDeps } from './deps.js';
import { classifySmtpError, type OutgoingMail } from './email-transport.js';

const Recipients = z.array(z.email().max(320)).min(1).max(50);

/** `deployment`: the server's own sender (EMAIL_DRIVER — Resend, SMTP or log). No per-destination credentials. */
const DeploymentEmailConfig = z.object({ transport: z.literal('deployment'), to: Recipients }).strict();

/** `smtp`: a relay configured on this destination (password in the SecretStore). */
const SmtpEmailConfig = z
  .object({
    transport: z.literal('smtp'),
    host: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65_535).default(587),
    /** Implicit TLS; defaults to true on port 465. */
    secure: z.boolean().optional(),
    /** Require STARTTLS on non-implicit-TLS ports. Disable only for local relays. */
    requireTLS: z.boolean().default(true),
    from: z.email().max(320),
    to: Recipients,
    /** SMTP user; defaults to `from` when a password secret is configured. */
    username: z.string().trim().min(1).max(320).optional(),
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

const SMTP_SECRET: SecretRequirement = { required: false, secretKind: 'OTHER', description: 'SMTP password (omit for unauthenticated relays)' };

/** Email delivery through the deployment sender (default) or a per-destination SMTP relay. */
export function createEmailAdapter(deps: Pick<DeliveryAdapterDeps, 'mailTransport' | 'timeoutMs' | 'emailSender'>): AlertDeliveryAdapter<EmailConfig> {
  return {
    kind: 'EMAIL',
    label: 'Email',
    secret: SMTP_SECRET,
    secretFor: (config) => (config.transport === 'smtp' ? SMTP_SECRET : null),
    validateConfig: (config) => checkConfig(EmailConfig, config),
    validateSecret: () => [],
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
