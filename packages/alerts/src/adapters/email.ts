import { z } from 'zod';
import { checkConfig } from '../config-check.js';
import { delivered, failed, type AlertDeliveryAdapter, type AlertMessage } from '../contract.js';
import { DEFAULT_TIMEOUT_MS, redactSecrets } from '../http.js';
import { renderAlert, type RenderedAlert } from '../render.js';
import type { DeliveryAdapterDeps } from './deps.js';
import { classifySmtpError, type OutgoingMail } from './email-transport.js';

const EmailConfig = z
  .object({
    host: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65_535).default(587),
    /** Implicit TLS; defaults to true on port 465. */
    secure: z.boolean().optional(),
    /** Require STARTTLS on non-implicit-TLS ports. Disable only for local relays. */
    requireTLS: z.boolean().default(true),
    from: z.email().max(320),
    to: z.array(z.email().max(320)).min(1).max(50),
    /** SMTP user; defaults to `from` when a password secret is configured. */
    username: z.string().trim().min(1).max(320).optional(),
  })
  .strict()
  .transform((c) => ({ ...c, secure: c.secure ?? c.port === 465 }));
export type EmailConfig = z.output<typeof EmailConfig>;

/** SMTP email delivery via an injected transport factory (nodemailer in production). */
export function createEmailAdapter(deps: Pick<DeliveryAdapterDeps, 'mailTransport' | 'timeoutMs'>): AlertDeliveryAdapter<EmailConfig> {
  return {
    kind: 'EMAIL',
    label: 'Email (SMTP)',
    secret: { required: false, secretKind: 'OTHER', description: 'SMTP password (omit for unauthenticated relays)' },
    validateConfig: (config) => checkConfig(EmailConfig, config),
    validateSecret: () => [],
    async deliver(message, config, secret) {
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

export function buildMail(message: AlertMessage, config: Pick<EmailConfig, 'from' | 'to'>): OutgoingMail {
  const r = renderAlert(message);
  return {
    from: config.from,
    to: [...config.to],
    subject: r.subject,
    text: textBody(r),
    html: htmlBody(r),
    headers: {
      'X-OCSO-Alert-Id': message.alertId,
      'X-OCSO-Alert-Event': message.event,
      'X-OCSO-Alert-Severity': message.severity,
    },
  };
}

function textBody(r: RenderedAlert): string {
  const lines = [r.headline, '', r.body, '', ...r.fields.map((f) => `${f.label}: ${f.value}`)];
  if (r.link) lines.push('', `Open in OCSO: ${r.link}`);
  lines.push('', r.footer);
  return lines.join('\n');
}

function htmlBody(r: RenderedAlert): string {
  const rows = r.fields.map((f) => `<tr><th align="left" style="padding:2px 12px 2px 0">${esc(f.label)}</th><td>${esc(f.value)}</td></tr>`).join('');
  const link = r.link ? `<p><a href="${esc(r.link)}">Open in OCSO</a></p>` : '';
  return [
    `<h2 style="font-family:sans-serif">${esc(r.headline)}</h2>`,
    `<p style="font-family:sans-serif;white-space:pre-line">${esc(r.body)}</p>`,
    `<table style="font-family:sans-serif;font-size:13px">${rows}</table>`,
    link,
    `<p style="font-family:sans-serif;color:#666;font-size:12px">${esc(r.footer)}</p>`,
  ].join('');
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
