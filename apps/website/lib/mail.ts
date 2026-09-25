import 'server-only';
import { serverEnv } from './env';

export type Email = { to: string; subject: string; html: string; text: string; replyTo?: string | undefined };

/**
 * Sends one email. EMAIL_PROVIDER picks the provider:
 *  - cloudflare (default): Cloudflare Email Service REST API, from a domain onboarded to Email Sending
 *    (winsenlabs.dev). Uses the same CLOUDFLARE_API_TOKEN as D1; it needs Email Sending: Edit.
 *  - resend: the Resend API with RESEND_API_KEY (or RESEND_API_KEY_FILE), from a Resend-verified domain.
 *  - log: prints instead of sending (local development).
 */
export async function sendEmail(email: Email) {
  const env = serverEnv();
  const to = env.redirectTo ?? email.to;
  const subject = `${env.subjectPrefix}${email.subject}`;
  const replyTo = email.replyTo ?? env.replyTo;

  if (env.emailProvider === 'log') {
    console.info(`[mail] (log provider) to=${to} subject=${JSON.stringify(subject)}`);
    return;
  }

  if (env.emailProvider === 'resend') {
    if (!env.resendKey) throw new Error('RESEND_API_KEY is not set');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.from, to: [to], reply_to: replyTo, subject, html: email.html, text: email.text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Resend failed (${res.status}): ${await res.text()}`);
    return;
  }

  if (!env.accountId || !env.apiToken) throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are needed to send email');
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.accountId}/email/sending/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.from, to, reply_to: replyTo, subject, html: email.html, text: email.text }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => null)) as { success?: boolean; errors?: { message: string }[]; result?: { permanent_bounces?: string[]; suppressed_recipients?: string[] } } | null;
  if (!res.ok || !body?.success) throw new Error(`Cloudflare Email Sending failed (${res.status}): ${body?.errors?.map((e) => e.message).join('; ') ?? 'no body'}`);
  const refused = [...(body.result?.permanent_bounces ?? []), ...(body.result?.suppressed_recipients ?? [])];
  if (refused.length) throw new Error(`Cloudflare Email Sending did not accept: ${refused.join(', ')}`);
}
