import { readFileSync } from 'node:fs';
import { normalizeMailbox } from './address.js';
import type { EmailDriver, EmailDriverContext, EmailDriverDefinition, EmailSender } from './contract.js';
import { DEFAULT_EMAIL_DRIVER, EMAIL_DRIVERS } from './drivers.js';
import type { EmailFetch } from './resend-sender.js';
import type { MailTransportFactory } from './smtp-transport.js';

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

/** What resolving the configuration needs besides the environment. */
export interface EmailResolveDeps {
  /** Reads *_FILE secrets; default fs.readFileSync (utf8). */
  readFile?: ((path: string) => string) | undefined;
  timeoutMs?: number | undefined;
  /** Registered email drivers (the composition root passes its registry); default EMAIL_DRIVERS. */
  drivers?: readonly EmailDriverDefinition[] | undefined;
}

export interface EmailSenderDeps extends EmailResolveDeps {
  fetch?: EmailFetch | undefined;
  transportFactory?: MailTransportFactory | undefined;
  /** Log driver output (one line per message). */
  log?: ((line: string) => void) | undefined;
  resendBaseUrl?: string | undefined;
}

export interface ResolvedEmailConfig {
  /** EMAIL_DRIVER in effect (the registered driver's name). */
  driver: EmailDriver;
  from: string;
  replyTo: string | null;
  /** Operator-facing notes (e.g. a non-delivering driver allowed in production). */
  warnings: string[];
  /** The selected driver. */
  definition: EmailDriverDefinition;
  /** What the driver resolved (credentials included): infrastructure-internal, never serialized. */
  options: unknown;
}

/** Secret-free summary for the Settings page and start-up logs. */
export interface EmailStatus {
  driver: EmailDriver;
  /** The driver's display name, e.g. `Resend`. */
  label: string;
  from: string | null;
  replyTo: string | null;
  /** True when messages actually leave the process (a delivering driver). */
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

/** From address of a non-delivering driver (log) when EMAIL_FROM is unset. */
export const LOG_DRIVER_FROM = 'OCSO <no-reply@ocso.invalid>';
const DOCS = 'docs/operations/compose.md §9';

/**
 * Validate the environment and resolve secrets. EMAIL_DRIVER names a
 * registered driver; unset it defaults to `log` in development/test and must
 * be set explicitly in production, where a non-delivering driver also needs
 * EMAIL_ALLOW_LOG_IN_PRODUCTION=true.
 */
export function resolveEmailConfig(env: EmailEnv, deps: EmailResolveDeps = {}): ResolvedEmailConfig {
  const drivers = deps.drivers ?? EMAIL_DRIVERS;
  const name = env.EMAIL_DRIVER ?? DEFAULT_EMAIL_DRIVER;
  const definition = drivers.find((d) => d.name === name);
  if (!definition) {
    throw new EmailConfigError([`EMAIL_DRIVER=${name} is not available; registered email drivers: ${drivers.map((d) => d.name).join(', ') || 'none'}`]);
  }
  const problems: string[] = [];
  const warnings: string[] = [];
  const production = env.NODE_ENV === 'production';
  const allowLog = env.EMAIL_ALLOW_LOG_IN_PRODUCTION === true;
  const delivering = drivers.filter((d) => d.delivers).map((d) => d.name).join(' or ') || 'a delivering driver';
  if (production && !env.EMAIL_DRIVER && !allowLog) {
    problems.push(`EMAIL_DRIVER is required in production: ${delivering} (see ${DOCS}); EMAIL_ALLOW_LOG_IN_PRODUCTION=true accepts the ${name} driver for a trial`);
  } else if (production && !definition.delivers) {
    if (!allowLog) problems.push(`EMAIL_DRIVER=${name} delivers no email; in production use ${delivering} (see ${DOCS}), or set EMAIL_ALLOW_LOG_IN_PRODUCTION=true for a trial`);
    else warnings.push(`${definition.label} driver in production: invites, password resets and sign-in codes are not delivered — nobody receives them.`);
  }

  const from = mailbox(env.EMAIL_FROM, 'EMAIL_FROM', problems);
  const replyTo = mailbox(env.EMAIL_REPLY_TO, 'EMAIL_REPLY_TO', problems);
  if (definition.delivers && !env.EMAIL_FROM) problems.push(`EMAIL_DRIVER=${name} requires EMAIL_FROM (an address on a domain verified with your provider)`);

  const read = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const ctx: EmailDriverContext = {
    from,
    timeoutMs: deps.timeoutMs ?? 10_000,
    problem: (message) => problems.push(message),
    secret: (value, file, secretName) => {
      if (value) return value.trim();
      if (!file) return null;
      try {
        const content = read(file).trim();
        if (!content) problems.push(`${secretName}_FILE points to an empty file`);
        return content || null;
      } catch {
        problems.push(`${secretName}_FILE points to a missing or unreadable file`);
        return null;
      }
    },
  };
  const options = definition.resolve(env, ctx);
  if (problems.length) throw new EmailConfigError(problems);
  return { driver: definition.name, from: from ?? LOG_DRIVER_FROM, replyTo, warnings, definition, options };
}

/** Build the deployment-wide sender from the environment (EMAIL_SENDER in api and worker). */
export function createEmailSender(env: EmailEnv, deps: EmailSenderDeps = {}): EmailSender {
  return senderFor(resolveEmailConfig(env, deps), deps);
}

export function senderFor(config: ResolvedEmailConfig, deps: EmailSenderDeps = {}): EmailSender {
  return config.definition.create(config.options, { from: config.from, replyTo: config.replyTo }, deps);
}

export function emailStatus(config: ResolvedEmailConfig): EmailStatus {
  const delivers = config.definition.delivers;
  return {
    driver: config.driver,
    label: config.definition.label,
    from: !delivers && config.from === LOG_DRIVER_FROM ? null : config.from,
    replyTo: config.replyTo,
    configured: delivers,
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
