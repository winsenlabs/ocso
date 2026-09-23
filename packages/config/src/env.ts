import { z } from 'zod';

/**
 * Typed, validated configuration (T1.2.1). Everything infrastructure-specific
 * is selected by driver name; business code never branches on it. Driver
 * names are open strings here: the composition root (@ocso/bootstrap) checks
 * each against its driver registry and runs that driver's own settings checks.
 */
const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

/** Compose passes unset settings as empty strings (`${VAR:-}`); treat them as absent. */
const blank = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

/** A driver name (`*_DRIVER`): any registered driver; the composition root validates it. */
const driverName = z.string().trim().min(1).max(64);

/**
 * Transactional email (invites, password reset, sign-in codes, alert emails).
 * Deployment bootstrap only — never stored in the database. Cross-field rules
 * (driver requirements, the production guard) live in @ocso/email's
 * resolveEmailConfig, which the api and worker run at start-up.
 */
function emailEnv() {
  return {
    /** A registered email driver (first party: resend | smtp | log). Default log in development/test; required in production. */
    EMAIL_DRIVER: blank(driverName),
    /** Sender, e.g. `Acme Support <support@mail.acme.com>` — a domain verified with the provider. */
    EMAIL_FROM: blank(z.string().max(320)),
    EMAIL_REPLY_TO: blank(z.string().max(320)),
    /** Accept EMAIL_DRIVER=log in production (trials only: nobody receives invites or resets). */
    EMAIL_ALLOW_LOG_IN_PRODUCTION: blank(bool),
    RESEND_API_KEY: blank(z.string().min(1).max(512)),
    /** File holding the Resend API key (the compose entrypoint resolves it into RESEND_API_KEY). */
    RESEND_API_KEY_FILE: blank(z.string()),
    /** smtp://user:pass@host:587 or smtps://host:465 — or the discrete SMTP_* settings below. */
    SMTP_URL: blank(z.string().max(2048)),
    SMTP_HOST: blank(z.string().max(253)),
    SMTP_PORT: blank(z.coerce.number().int().min(1).max(65_535)),
    /** Implicit TLS; default true on port 465. */
    SMTP_SECURE: blank(bool),
    /** Require STARTTLS on non-TLS ports (default true); false only for a local relay such as Mailpit. */
    SMTP_REQUIRE_TLS: blank(bool),
    SMTP_USER: blank(z.string().max(320)),
    SMTP_PASSWORD: blank(z.string().max(1024)),
    SMTP_PASSWORD_FILE: blank(z.string()),
  };
}

/**
 * The audit store (PM/research/11 §6.5, ADR-032): a separate database that is the
 * system of record for audit events, selected by AUDIT_DRIVER. The worker connects
 * with the writer credentials (INSERT/SELECT only), the api with the reader's
 * (SELECT only) where the deployment provisions one; the migrate step provisions
 * both with owner credentials (AuditToolsEnv).
 */
function auditEnv() {
  return {
    /** A registered audit store driver (first party: postgres | clickhouse). */
    AUDIT_DRIVER: driverName.default('postgres'),
    /** Writer connection to the audit database (postgres driver). */
    AUDIT_DATABASE_URL: blank(z.string().url()),
    /** File holding AUDIT_DATABASE_URL (Compose keygen writes it; a non-empty AUDIT_DATABASE_URL wins). */
    AUDIT_DATABASE_URL_FILE: blank(z.string()),
    AUDIT_DATABASE_SSL: blank(bool),
    AUDIT_DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(5),
    /** ClickHouse HTTP interface, e.g. http://clickhouse:8123 (clickhouse driver). */
    CLICKHOUSE_URL: blank(z.string().url()),
    CLICKHOUSE_DATABASE: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/).default('ocso_audit'),
    /** The store user: the writer (SELECT, INSERT) for the worker; the read-only user for the api. */
    CLICKHOUSE_USER: blank(z.string().max(128)),
    CLICKHOUSE_PASSWORD: blank(z.string().max(1024)),
    CLICKHOUSE_PASSWORD_FILE: blank(z.string()),
    /**
     * Worker only: the user that purges months past retention (ClickHouse needs ALTER DELETE to drop a
     * partition, so the writer never holds it). Unset = no purge from the worker.
     */
    CLICKHOUSE_PURGE_USER: blank(z.string().max(128)),
    CLICKHOUSE_PURGE_PASSWORD: blank(z.string().max(1024)),
    CLICKHOUSE_PURGE_PASSWORD_FILE: blank(z.string()),
    /** Bound on one audit store call (ms): a store that stops answering fails fast instead of stalling the worker's leader tasks. */
    AUDIT_STORE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(15_000),
    /** Retired audit signing keys' public halves (concatenated SPKI PEMs): older checkpoints and exports still verify. */
    AUDIT_TRUSTED_PUBLIC_KEYS_FILE: blank(z.string()),
    /** The same bundle inline (ECS); used together with the file when both are set. Public keys, not secrets. */
    AUDIT_TRUSTED_PUBLIC_KEYS: blank(z.string().max(65_536)),
    /** Ed25519 private key (PKCS#8 PEM) that signs audit checkpoints, exports and exception reports; required in production. */
    AUDIT_SIGNING_KEY_FILE: blank(z.string()),
    /** The same key inline (ECS injects secrets as variables); wins over AUDIT_SIGNING_KEY_FILE. */
    AUDIT_SIGNING_KEY: blank(z.string().max(4096)),
  };
}

const common = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  APP_VERSION: z.string().default('dev'),
  DATABASE_URL: z.string().url(),
  DATABASE_SSL: bool.default(false),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(200).default(10),

  /** A registered queue driver (first party: postgres | sqs). */
  QUEUE_DRIVER: driverName.default('postgres'),
  SQS_QUEUE_URLS: z.string().optional(),
  AWS_REGION: z.string().optional(),

  /** A registered blob driver (first party: local | s3). */
  BLOB_DRIVER: driverName.default('local'),
  BLOB_LOCAL_DIR: z.string().default('./data/blobs'),
  BLOB_SIGNING_KEY: z.string().min(16).optional(),
  S3_BUCKET: z.string().optional(),
  S3_ENDPOINT: z.string().url().optional(),
  S3_KMS_KEY_ID: z.string().optional(),

  /** A registered secrets driver (first party: local | aws). */
  SECRETS_DRIVER: driverName.default('local'),
  /** Base64 32-byte key (or path via OCSO_SECRETS_MASTER_KEY_FILE). */
  OCSO_SECRETS_MASTER_KEY: z.string().optional(),
  OCSO_SECRETS_MASTER_KEY_FILE: z.string().optional(),
  SECRETS_NAME_PREFIX: z.string().default('ocso'),

  /** A registered deployment driver (first party: compose | ecs); worker only. */
  DEPLOYMENT_DRIVER: driverName.default('compose'),
  ECS_CLUSTER: z.string().optional(),
  ECS_WORKER_SERVICE: z.string().optional(),

  OTEL_ENABLED: bool.default(false),
  OCSO_ENABLE_DEV_PROVIDERS: bool.default(false),
  /**
   * Download the open-source model catalogs (models.dev, LiteLLM) for prices and model metadata
   * (ADR-027). false = air-gapped: the bundled snapshot is used and refresh is disabled.
   */
  OCSO_MODEL_CATALOG_REFRESH: bool.default(true),
  /** Public origin customers and providers reach (webhooks, widget, signed URLs). */
  OCSO_PUBLIC_URL: z.string().url().default('http://localhost:3000'),

  ...emailEnv(),
  ...auditEnv(),
} as const;

export const ApiEnv = z.object({
  ...common,
  PORT: z.coerce.number().int().default(4000),
  /** One-time token required by the first-run setup page (logged if absent). */
  OCSO_SETUP_TOKEN: z.string().min(16).optional(),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).default(120),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).default(24),
  /**
   * Authentication (Better Auth, ADR-025) — deployment bootstrap, never stored in the database.
   * Secret (≥ 32 chars) that signs session cookies and encrypts TOTP secrets and backup codes;
   * required in production (Compose keygen generates it; the entrypoint resolves BETTER_AUTH_SECRET_FILE).
   */
  BETTER_AUTH_SECRET: blank(z.string().min(32).max(1024)),
  /** `Secure` session cookies (`__Secure-` prefix). Default: true when OCSO_PUBLIC_URL is https. */
  SESSION_COOKIE_SECURE: blank(bool),
  /** Extra origins Better Auth trusts, comma-separated (e.g. an IdP on a private network). */
  OCSO_AUTH_TRUSTED_ORIGINS: blank(z.string().max(4000)),
  /** Better Auth's database-backed rate limiter (default on); off only for load tests. */
  OCSO_AUTH_RATE_LIMIT: blank(bool),
  /** Break-glass: while set (≥ 32 chars), /recover resets one Tech admin's password — each value works once. */
  OCSO_RECOVERY_TOKEN: blank(z.string().min(32).max(512)),
  /** How often long-lived streams (staff SSE, Ask OCSO) re-check their session; they close when it ended. */
  SESSION_STREAM_RECHECK_SECONDS: z.coerce.number().int().min(1).max(300).default(60),
  /** Test-only hooks (e.g. emails captured by the log driver); refused when NODE_ENV=production. */
  OCSO_ENABLE_TEST_HOOKS: blank(bool),
  /**
   * Development and test only (PM/research/11 §3.4): new users are created ACTIVE and preset upgrades,
   * re-enabling and team additions apply at once instead of waiting for approval. Per-user grants always
   * need approval. Refused when NODE_ENV=production.
   */
  OCSO_DEV_SKIP_ACCESS_APPROVAL: blank(bool),
  TRUST_PROXY: bool.default(true),
  /** Deep link from telemetry to the trace backend, e.g. `http://localhost:16686/trace/{traceId}`. */
  OCSO_TRACE_URL_TEMPLATE: z.string().includes('{traceId}').optional(),
});
export type ApiEnv = z.infer<typeof ApiEnv>;

export const WorkerEnv = z.object({
  ...common,
  HEALTH_PORT: z.coerce.number().int().default(4100),
  WORKER_ID: z.string().optional(),
  /** Overrides the DB setting for local experiments; normally unset. */
  WORKER_CAPACITY: z.coerce.number().int().min(1).optional(),
  /** CloudWatch namespace for the ADR-023 scaling metrics (ECS); defaults to Terraform's `OCSO/<ECS_CLUSTER>`. */
  OCSO_METRICS_NAMESPACE: z.string().min(1).max(255).optional(),
  /** Set by the ECS agent inside every task; enables turn-scoped scale-in protection. */
  ECS_AGENT_URI: z.string().url().optional(),
});
export type WorkerEnv = z.infer<typeof WorkerEnv>;

/**
 * Values never echoed in config errors (RESEND_API_KEY via KEY; SMTP_URL, the audit
 * owner URL and CLICKHOUSE_URL can embed a password).
 */
const SECRET_NAMES = /(KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL|DATABASE_OWNER_URL|SMTP_URL|CLICKHOUSE_URL)/;

/** Parse env or throw a readable error that never echoes secret values. */
export function loadEnv<T extends z.ZodTypeAny>(schema: T, source: NodeJS.ProcessEnv = process.env): z.infer<T> {
  const parsed = schema.safeParse(source);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((issue) => {
    const key = issue.path.join('.');
    const hint = SECRET_NAMES.test(key) ? '(value hidden)' : '';
    return `  - ${key}: ${issue.message} ${hint}`.trimEnd();
  });
  throw new Error(`Invalid OCSO configuration:\n${problems.join('\n')}`);
}

/**
 * Cross-field checks that zod object schemas cannot express cleanly. Driver
 * selection and each driver's own settings are checked by the composition
 * root (@ocso/bootstrap `assertDrivers`), which knows the registered drivers.
 */
export function assertDriverConfig(env: z.infer<typeof ApiEnv> | z.infer<typeof WorkerEnv>): void {
  const problems: string[] = [];
  if (env.NODE_ENV === 'production' && env.OCSO_ENABLE_DEV_PROVIDERS && process.env['OCSO_ALLOW_DEV_PROVIDERS_IN_PRODUCTION'] !== 'true') {
    problems.push('OCSO_ENABLE_DEV_PROVIDERS must be false in production (set OCSO_ALLOW_DEV_PROVIDERS_IN_PRODUCTION=true to override for demos)');
  }
  if (problems.length) throw new Error(`Invalid OCSO configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
}

/** Authentication bootstrap checks (ADR-025); the API runs these at start-up. */
export function assertAuthConfig(env: z.infer<typeof ApiEnv>): void {
  const problems: string[] = [];
  if (env.NODE_ENV === 'production' && !env.BETTER_AUTH_SECRET) problems.push('BETTER_AUTH_SECRET (≥ 32 chars) is required in production (Compose: generated by keygen)');
  if (env.NODE_ENV === 'production' && env.OCSO_ENABLE_TEST_HOOKS) problems.push('OCSO_ENABLE_TEST_HOOKS must be off in production');
  if (env.NODE_ENV === 'production' && env.OCSO_DEV_SKIP_ACCESS_APPROVAL) {
    problems.push('OCSO_DEV_SKIP_ACCESS_APPROVAL must be off in production (new users and access increases need approval)');
  }
  // NODE_ENV defaults to development: skipping approval must never happen because someone forgot to set it.
  if (env.OCSO_DEV_SKIP_ACCESS_APPROVAL && !['development', 'test'].includes(process.env['NODE_ENV'] ?? '')) {
    problems.push('OCSO_DEV_SKIP_ACCESS_APPROVAL needs NODE_ENV set explicitly to development or test');
  }
  for (const origin of (env.OCSO_AUTH_TRUSTED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean)) {
    if (!URL.canParse(origin) || !/^https?:$/.test(new URL(origin).protocol)) problems.push(`OCSO_AUTH_TRUSTED_ORIGINS: ${origin} is not an http(s) origin`);
  }
  if (problems.length) throw new Error(`Invalid OCSO configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
}

export function parseQueueUrls(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  return Object.fromEntries(
    raw
      .split(',')
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const [topic, url] = pair.split('=');
        if (!topic || !url) throw new Error('SQS_QUEUE_URLS must be topic=url pairs separated by commas');
        return [topic.trim(), url.trim()];
      }),
  );
}

/**
 * The audit store's provisioning and verification tools (`audit-migrate`,
 * `audit-verify`): the store settings plus migrate-only owner credentials. Only
 * the migrate step sees these; the api and worker never hold owner credentials.
 */
export const AuditToolsEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ...auditEnv(),
  /** Owner connection (creates tables, functions, the writer role) — postgres driver. */
  AUDIT_DATABASE_OWNER_URL: blank(z.string().url()),
  AUDIT_DATABASE_OWNER_URL_FILE: blank(z.string()),
  /** Password set on the writer role; default: the password in AUDIT_DATABASE_URL. */
  AUDIT_WRITER_PASSWORD: blank(z.string().min(8).max(1024)),
  AUDIT_WRITER_PASSWORD_FILE: blank(z.string()),
  /** The api's read-only connection (postgres driver); its user becomes the SELECT-only reader role. */
  AUDIT_READER_URL: blank(z.string().url()),
  AUDIT_READER_URL_FILE: blank(z.string()),
  /** Password set on the reader role/user; default: the password in AUDIT_READER_URL. */
  AUDIT_READER_PASSWORD: blank(z.string().min(8).max(1024)),
  AUDIT_READER_PASSWORD_FILE: blank(z.string()),
  /** The api's read-only ClickHouse user (clickhouse driver). */
  CLICKHOUSE_READER_USER: blank(z.string().max(128)),
  /** false: the DBA created the writer role/user (managed databases); only grants are applied. */
  AUDIT_PROVISION_ROLE: bool.default(true),
  /** The store's own minimum retention: no purge removes anything younger, whatever the writer asks (≥ 365). */
  AUDIT_MIN_RETENTION_DAYS: z.coerce.number().int().min(365).max(36_500).default(365),
  /** Production refuses a writer that is the owner/admin (append-only unenforced) unless this is true. */
  AUDIT_ALLOW_OWNER_WRITER: bool.default(false),
  /** ClickHouse user allowed to create the database, tables and the writer user. */
  CLICKHOUSE_ADMIN_USER: blank(z.string().max(128)),
  CLICKHOUSE_ADMIN_PASSWORD: blank(z.string().max(1024)),
  CLICKHOUSE_ADMIN_PASSWORD_FILE: blank(z.string()),
});
export type AuditToolsEnv = z.infer<typeof AuditToolsEnv>;
/** The settings an audit store driver reads at runtime (a subset of ApiEnv and WorkerEnv). */
export type AuditDriverEnv = Pick<ApiEnv, keyof ReturnType<typeof auditEnv> | 'NODE_ENV'>;
