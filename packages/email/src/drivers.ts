import { mailboxAddress } from './address.js';
import type { EmailEnv } from './config.js';
import type { EmailDriverContext, EmailDriverDefinition } from './contract.js';
import { LogEmailSender } from './log-sender.js';
import { ResendEmailSender } from './resend-sender.js';
import { SmtpEmailSender } from './smtp-sender.js';
import type { SmtpTransportOptions } from './smtp-transport.js';

/** Resend HTTPS API (RESEND_API_KEY or RESEND_API_KEY_FILE). */
export const resendEmailDriver: EmailDriverDefinition<{ apiKey: string }> = {
  name: 'resend',
  label: 'Resend',
  delivers: true,
  resolve(env, ctx) {
    const apiKey = ctx.secret(env.RESEND_API_KEY, env.RESEND_API_KEY_FILE, 'RESEND_API_KEY');
    if (apiKey) return { apiKey };
    if (!env.RESEND_API_KEY_FILE) ctx.problem('EMAIL_DRIVER=resend requires RESEND_API_KEY or RESEND_API_KEY_FILE');
    return null;
  },
  create: (options, sender, deps) =>
    new ResendEmailSender({
      apiKey: options.apiKey,
      from: sender.from,
      replyTo: sender.replyTo,
      baseUrl: deps.resendBaseUrl,
      fetch: deps.fetch,
      timeoutMs: deps.timeoutMs,
    }),
};

/** Any SMTP relay (SMTP_URL or SMTP_HOST/SMTP_PORT/…, password from SMTP_PASSWORD or SMTP_PASSWORD_FILE). */
export const smtpEmailDriver: EmailDriverDefinition<SmtpTransportOptions> = {
  name: 'smtp',
  label: 'SMTP',
  delivers: true,
  resolve: (env, ctx) => smtpOptions(env, ctx.secret(env.SMTP_PASSWORD, env.SMTP_PASSWORD_FILE, 'SMTP_PASSWORD'), ctx),
  create: (smtp, sender, deps) => new SmtpEmailSender({ from: sender.from, replyTo: sender.replyTo, smtp, transportFactory: deps.transportFactory }),
};

/** Development/test: messages are recorded and logged, never delivered. */
export const logEmailDriver: EmailDriverDefinition<Record<string, never>> = {
  name: 'log',
  label: 'Log — development only',
  delivers: false,
  resolve: () => ({}),
  create: (_options, sender, deps) => new LogEmailSender(sender.from, deps.log ?? null),
};

/** First-party email drivers, in the order the docs list them. */
export const EMAIL_DRIVERS: readonly EmailDriverDefinition[] = [resendEmailDriver, smtpEmailDriver, logEmailDriver];

/** EMAIL_DRIVER when unset: accepted in development/test, refused in production unless explicitly allowed. */
export const DEFAULT_EMAIL_DRIVER = logEmailDriver.name;

function smtpOptions(env: EmailEnv, password: string | null, ctx: EmailDriverContext): SmtpTransportOptions | null {
  let host = env.SMTP_HOST;
  let port = env.SMTP_PORT;
  let secure = env.SMTP_SECURE;
  let user = env.SMTP_USER;
  let pass = password;
  if (env.SMTP_URL) {
    let url: URL;
    try {
      url = new URL(env.SMTP_URL);
    } catch {
      ctx.problem('SMTP_URL must look like smtp://user:password@host:587 or smtps://host:465 (value hidden)');
      return null;
    }
    if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') {
      ctx.problem('SMTP_URL must use the smtp:// or smtps:// scheme');
      return null;
    }
    host ??= url.hostname || undefined;
    secure ??= url.protocol === 'smtps:';
    port ??= url.port ? Number(url.port) : undefined;
    user ??= url.username ? decodeURIComponent(url.username) : undefined;
    pass ??= url.password ? decodeURIComponent(url.password) : null;
  }
  if (!host) {
    ctx.problem('EMAIL_DRIVER=smtp requires SMTP_HOST or SMTP_URL');
    return null;
  }
  const effectivePort = port ?? (secure ? 465 : 587);
  const auth = pass ? { user: user ?? (ctx.from ? mailboxAddress(ctx.from) : ''), pass } : undefined;
  if (auth && !auth.user) ctx.problem('SMTP_PASSWORD requires SMTP_USER (or EMAIL_FROM as the user name)');
  return { host, port: effectivePort, secure: secure ?? effectivePort === 465, requireTLS: env.SMTP_REQUIRE_TLS ?? true, auth, timeoutMs: ctx.timeoutMs };
}
