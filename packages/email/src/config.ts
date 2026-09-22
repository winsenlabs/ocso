import { readFileSync } from 'node:fs';
import { mailboxAddress, normalizeMailbox } from './address.js';
import type { EmailDriver, EmailSender } from './contract.js';
import { LogEmailSender } from './log-sender.js';
import { ResendEmailSender, type EmailFetch } from './resend-sender.js';
import { SmtpEmailSender } from './smtp-sender.js';
import type { MailTransportFactory, SmtpTransportOptions } from './smtp-transport.js';

/**
 * Deployment email configuration (bootstrap only: environment and secret
 * files, never the database). Structural subset of ApiEnv / WorkerEnv from
 * @ocso/config, so this package does not depend on it.
 */
export interface EmailEnv {
  NODE_ENV?: string | undefined;
  EMAIL_DRIVER?: EmailDriver | undefined;
  EMAIL_FROM?: string | undefined;
  EMAIL_REPLY_TO?: string | undefined;
  EMAIL_ALLOW_LOG_IN_PRODUCTION?: boolean | undefined;
  RESEND_API_KEY?: string | undefined;
  RESEND_API_KEY_FILE?: string | undefined;
  SMTP_URL?: string | undefined;
  SMTP_HOST?: string | undefined;
  SMTP_PORT?: number | undefined;
  SMTP_SECURE?: boolean | undefined;
  SMTP_REQUIRE_TLS?: boolean | undefined;
  SMTP_USER?: string | undefined;
  SMTP_PASSWORD?: string | undefined;
  SMTP_PASSWORD_FILE?: string | undefined;
}

export interface EmailSenderDeps {
  fetch?: EmailFetch | undefined;
  transportFactory?: MailTransportFactory | undefined;
  /** Reads *_FILE secrets; default fs.readFileSync (utf8). */
  readFile?: ((path: string) => string) | undefined;
  /** Log driver output (one line per message). */
  log?: ((line: string) => void) | undefined;
  resendBaseUrl?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface ResolvedEmailConfig {
  driver: EmailDriver;
  from: string;
  replyTo: string | null;
  /** Operator-facing notes (e.g. log driver allowed in production). */
  warnings: string[];
  resend: { apiKey: string } | null;
  smtp: SmtpTransportOptions | null;
}

/** Secret-free summary for the Settings page and start-up logs. */
export interface EmailStatus {
  driver: EmailDriver;
  from: string | null;
  replyTo: string | null;
  /** True when messages actually leave the process (resend / smtp). */
  configured: boolean;
  warnings: string[];
}

/** Thrown at start-up; the message lists every problem and never includes secret values. */
export class EmailConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid OCSO configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'EmailConfigError';
  }
}

/** From address of the log driver when EMAIL_FROM is unset. */
export const LOG_DRIVER_FROM = 'OCSO <no-reply@ocso.invalid>';
const DOCS = 'docs/operations/compose.md §9';

/**
 * Validate the environment and resolve secrets. EMAIL_DRIVER defaults to
 * `log` in development/test and must be set explicitly in production, where
 * `log` also needs EMAIL_ALLOW_LOG_IN_PRODUCTION=true.
 */
export function resolveEmailConfig(env: EmailEnv, deps: Pick<EmailSenderDeps, 'readFile' | 'timeoutMs'> = {}): ResolvedEmailConfig {
  const problems: string[] = [];
  const warnings: string[] = [];
  const production = env.NODE_ENV === 'production';
  const allowLog = env.EMAIL_ALLOW_LOG_IN_PRODUCTION === true;
  const driver: EmailDriver = env.EMAIL_DRIVER ?? 'log';
  if (production && !env.EMAIL_DRIVER && !allowLog) {
    problems.push(`EMAIL_DRIVER is required in production: resend or smtp (see ${DOCS}); EMAIL_ALLOW_LOG_IN_PRODUCTION=true accepts the log driver for a trial`);
  } else if (production && driver === 'log') {
    if (!allowLog) problems.push(`EMAIL_DRIVER=log delivers no email; in production use resend or smtp (see ${DOCS}), or set EMAIL_ALLOW_LOG_IN_PRODUCTION=true for a trial`);
    else warnings.push('Log driver in production: invites, password resets and sign-in codes are only written to the server log — nobody receives them.');
  }

  const from = mailbox(env.EMAIL_FROM, 'EMAIL_FROM', problems);
  const replyTo = mailbox(env.EMAIL_REPLY_TO, 'EMAIL_REPLY_TO', problems);
  if (driver !== 'log' && !env.EMAIL_FROM) problems.push(`EMAIL_DRIVER=${driver} requires EMAIL_FROM (an address on a domain verified with your provider)`);

  const read = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const secret = (value: string | undefined, file: string | undefined, name: string): string | null => {
    if (value) return value.trim();
    if (!file) return null;
    try {
      const content = read(file).trim();
      if (!content) problems.push(`${name}_FILE points to an empty file`);
      return content || null;
    } catch {
      problems.push(`${name}_FILE points to a missing or unreadable file`);
      return null;
    }
  };

  let resend: ResolvedEmailConfig['resend'] = null;
  let smtp: SmtpTransportOptions | null = null;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  if (driver === 'resend') {
    const apiKey = secret(env.RESEND_API_KEY, env.RESEND_API_KEY_FILE, 'RESEND_API_KEY');
    if (apiKey) resend = { apiKey };
    else if (!env.RESEND_API_KEY_FILE) problems.push('EMAIL_DRIVER=resend requires RESEND_API_KEY or RESEND_API_KEY_FILE');
  } else if (driver === 'smtp') {
    smtp = smtpOptions(env, secret(env.SMTP_PASSWORD, env.SMTP_PASSWORD_FILE, 'SMTP_PASSWORD'), from, timeoutMs, problems);
  }
  if (problems.length) throw new EmailConfigError(problems);
  return { driver, from: from ?? LOG_DRIVER_FROM, replyTo, warnings, resend, smtp };
}

/** Build the deployment-wide sender from the environment (EMAIL_SENDER in api and worker). */
export function createEmailSender(env: EmailEnv, deps: EmailSenderDeps = {}): EmailSender {
  return senderFor(resolveEmailConfig(env, deps), deps);
}

export function senderFor(config: ResolvedEmailConfig, deps: EmailSenderDeps = {}): EmailSender {
  switch (config.driver) {
    case 'resend':
      return new ResendEmailSender({
        apiKey: config.resend!.apiKey,
        from: config.from,
        replyTo: config.replyTo,
        baseUrl: deps.resendBaseUrl,
        fetch: deps.fetch,
        timeoutMs: deps.timeoutMs,
      });
    case 'smtp':
      return new SmtpEmailSender({ from: config.from, replyTo: config.replyTo, smtp: config.smtp!, transportFactory: deps.transportFactory });
    case 'log':
      return new LogEmailSender(config.from, deps.log ?? null);
  }
}

export function emailStatus(config: ResolvedEmailConfig): EmailStatus {
  return {
    driver: config.driver,
    from: config.driver === 'log' && config.from === LOG_DRIVER_FROM ? null : config.from,
    replyTo: config.replyTo,
    configured: config.driver !== 'log',
    warnings: [...config.warnings],
  };
}

function mailbox(value: string | undefined, setting: string, problems: string[]): string | null {
  if (!value) return null;
  try {
    return normalizeMailbox(value, setting);
  } catch (error) {
    problems.push((error as Error).message);
    return null;
  }
}

function smtpOptions(env: EmailEnv, password: string | null, from: string | null, timeoutMs: number, problems: string[]): SmtpTransportOptions | null {
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
      problems.push('SMTP_URL must look like smtp://user:password@host:587 or smtps://host:465 (value hidden)');
      return null;
    }
    if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') {
      problems.push('SMTP_URL must use the smtp:// or smtps:// scheme');
      return null;
    }
    host ??= url.hostname || undefined;
    secure ??= url.protocol === 'smtps:';
    port ??= url.port ? Number(url.port) : undefined;
    user ??= url.username ? decodeURIComponent(url.username) : undefined;
    pass ??= url.password ? decodeURIComponent(url.password) : null;
  }
  if (!host) {
    problems.push('EMAIL_DRIVER=smtp requires SMTP_HOST or SMTP_URL');
    return null;
  }
  const effectivePort = port ?? (secure ? 465 : 587);
  const auth = pass ? { user: user ?? (from ? mailboxAddress(from) : ''), pass } : undefined;
  if (auth && !auth.user) problems.push('SMTP_PASSWORD requires SMTP_USER (or EMAIL_FROM as the user name)');
  return { host, port: effectivePort, secure: secure ?? effectivePort === 465, requireTLS: env.SMTP_REQUIRE_TLS ?? true, auth, timeoutMs };
}
