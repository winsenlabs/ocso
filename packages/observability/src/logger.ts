import pino, { type Logger, type LoggerOptions } from 'pino';

/**
 * Structured JSON logging with secret redaction (build rule §21). Every log
 * line carries service + version; OTel instrumentation adds trace_id/span_id.
 */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-hub-signature-256"]',
  'req.headers["x-ocso-customer-claims"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.apiKey',
  '*.secret',
  '*.clientSecret',
  '*.credentials',
  '*.authorization',
  '*.codeVerifier',
  'secrets',
  '*.secrets',
];

export interface LoggerConfig {
  service: string;
  version: string;
  level: string;
  pretty?: boolean | undefined;
}

export function loggerOptions(config: LoggerConfig): LoggerOptions {
  return {
    level: config.level,
    base: { service: config.service, version: config.version },
    redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  };
}

export function createLogger(config: LoggerConfig): Logger {
  return pino(loggerOptions(config));
}

export type { Logger };
