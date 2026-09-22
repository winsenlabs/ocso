import { z } from 'zod';

/**
 * Typed, validated configuration (T1.2.1). Everything infrastructure-specific
 * is selected here by driver name; business code never branches on it.
 */
const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const common = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  APP_VERSION: z.string().default('dev'),
  DATABASE_URL: z.string().url(),
  DATABASE_SSL: bool.default(false),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(200).default(10),

  QUEUE_DRIVER: z.enum(['postgres', 'sqs']).default('postgres'),
  SQS_QUEUE_URLS: z.string().optional(),
  AWS_REGION: z.string().optional(),

  BLOB_DRIVER: z.enum(['local', 's3']).default('local'),
  BLOB_LOCAL_DIR: z.string().default('./data/blobs'),
  BLOB_SIGNING_KEY: z.string().min(16).optional(),
  S3_BUCKET: z.string().optional(),
  S3_ENDPOINT: z.string().url().optional(),
  S3_KMS_KEY_ID: z.string().optional(),

  SECRETS_DRIVER: z.enum(['local', 'aws']).default('local'),
  /** Base64 32-byte key (or path via OCSO_SECRETS_MASTER_KEY_FILE). */
  OCSO_SECRETS_MASTER_KEY: z.string().optional(),
  OCSO_SECRETS_MASTER_KEY_FILE: z.string().optional(),
  SECRETS_NAME_PREFIX: z.string().default('ocso'),

  DEPLOYMENT_DRIVER: z.enum(['compose', 'ecs']).default('compose'),
  ECS_CLUSTER: z.string().optional(),
  ECS_WORKER_SERVICE: z.string().optional(),

  OTEL_ENABLED: bool.default(false),
  OCSO_ENABLE_DEV_PROVIDERS: bool.default(false),
  /** Public origin customers and providers reach (webhooks, widget, signed URLs). */
  OCSO_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  /** HMAC key for customer identity claims / visitor tokens bootstrap (rotated via SecretStore). */
  OCSO_INTERNAL_SIGNING_KEY: z.string().min(32).optional(),
} as const;

export const ApiEnv = z.object({
  ...common,
  PORT: z.coerce.number().int().default(4000),
  /** One-time token required by the first-run setup page (logged if absent). */
  OCSO_SETUP_TOKEN: z.string().min(16).optional(),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).default(120),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).default(24),
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

const SECRET_NAMES = /(KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL)/;

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

/** Cross-field checks that zod object schemas cannot express cleanly. */
export function assertDriverConfig(env: z.infer<typeof ApiEnv> | z.infer<typeof WorkerEnv>): void {
  const problems: string[] = [];
  if (env.QUEUE_DRIVER === 'sqs' && (!env.SQS_QUEUE_URLS || !env.AWS_REGION)) problems.push('QUEUE_DRIVER=sqs requires SQS_QUEUE_URLS and AWS_REGION');
  if (env.BLOB_DRIVER === 's3' && !env.S3_BUCKET) problems.push('BLOB_DRIVER=s3 requires S3_BUCKET');
  if (env.BLOB_DRIVER === 'local' && !env.BLOB_SIGNING_KEY) problems.push('BLOB_DRIVER=local requires BLOB_SIGNING_KEY');
  if (env.SECRETS_DRIVER === 'local' && !env.OCSO_SECRETS_MASTER_KEY && !env.OCSO_SECRETS_MASTER_KEY_FILE) {
    problems.push('SECRETS_DRIVER=local requires OCSO_SECRETS_MASTER_KEY or OCSO_SECRETS_MASTER_KEY_FILE');
  }
  if (env.DEPLOYMENT_DRIVER === 'ecs' && (!env.ECS_CLUSTER || !env.ECS_WORKER_SERVICE)) problems.push('DEPLOYMENT_DRIVER=ecs requires ECS_CLUSTER and ECS_WORKER_SERVICE');
  if (env.NODE_ENV === 'production' && env.OCSO_ENABLE_DEV_PROVIDERS && process.env['OCSO_ALLOW_DEV_PROVIDERS_IN_PRODUCTION'] !== 'true') {
    problems.push('OCSO_ENABLE_DEV_PROVIDERS must be false in production (set OCSO_ALLOW_DEV_PROVIDERS_IN_PRODUCTION=true to override for demos)');
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
