data "aws_caller_identity" "current" {}

locals {
  prefix         = "${var.name}-${var.environment}" # ocso-prod
  secrets_prefix = "${var.name}/${var.environment}" # ocso/prod
  public_url     = "https://${var.public_hostname}"

  metrics_namespace = coalesce(var.worker_scaling.metric_namespace, "OCSO/${local.prefix}")
  # Alarms the worker's ECS deployment adapter may create/update/delete are
  # named "<ECS_CLUSTER>-worker-…" (the cluster name equals local.prefix).
  scaling_alarm_prefix = "${local.prefix}-worker-"

  # Service names inside the cluster. `worker` must match ECS_WORKER_SERVICE.
  services = {
    api    = "api"
    web    = "web"
    worker = "worker"
  }

  images = { for k, url in module.ecr.repository_urls : k => "${url}:${var.image_tag}" }

  # Baked into the api/worker/migrate images by the Dockerfile; pg verifies
  # the RDS server certificate against it (DATABASE_SSL=true → rejectUnauthorized).
  rds_ca_bundle = "/etc/ssl/certs/rds-global-bundle.pem"

  bootstrap_arn = module.secrets.bootstrap_secret_arn

  # --- Environment contract: packages/config/src/env.ts --------------------
  database_env = {
    DATABASE_SSL        = "true"
    DATABASE_POOL_SIZE  = tostring(var.database_pool_size)
    NODE_EXTRA_CA_CERTS = local.rds_ca_bundle
    # Audit store (ADR-032): postgres driver on the same RDS instance, TLS like the main database.
    AUDIT_DRIVER             = "postgres"
    AUDIT_DATABASE_SSL       = "true"
    AUDIT_MIN_RETENTION_DAYS = tostring(var.audit_store.min_retention_days)
    # Retired signing public keys (not secret): older checkpoints and exports still verify.
    AUDIT_TRUSTED_PUBLIC_KEYS = var.audit_trusted_public_keys
  }

  otel_env = var.otel_collector.enabled ? {
    OTEL_ENABLED = "true"
    # 127.0.0.1, not localhost: Node may resolve localhost to ::1 first.
    OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318"
    OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"
    OTEL_TRACES_SAMPLER         = "parentbased_traceidratio"
    OTEL_TRACES_SAMPLER_ARG     = tostring(var.otel_collector.traces_sample_ratio)
    } : {
    OTEL_ENABLED = "false"
  }

  app_env = merge(local.database_env, local.otel_env, {
    NODE_ENV            = "production"
    LOG_LEVEL           = var.log_level
    APP_VERSION         = var.image_tag
    AWS_REGION          = var.aws_region
    QUEUE_DRIVER        = "sqs"
    SQS_QUEUE_URLS      = module.sqs.sqs_queue_urls_env
    BLOB_DRIVER         = "s3"
    S3_BUCKET           = module.s3.bucket_name
    S3_KMS_KEY_ID       = module.s3.kms_key_arn
    SECRETS_DRIVER      = "aws"
    SECRETS_NAME_PREFIX = module.secrets.runtime_prefix
    # Shared config validation requires ECS_CLUSTER/ECS_WORKER_SERVICE whenever
    # DEPLOYMENT_DRIVER=ecs, so api gets them too; only the worker role can act.
    DEPLOYMENT_DRIVER         = "ecs"
    ECS_CLUSTER               = module.ecs_cluster.name
    ECS_WORKER_SERVICE        = local.services.worker
    OCSO_PUBLIC_URL           = local.public_url
    OCSO_ENABLE_DEV_PROVIDERS = "false"
  }, local.email_env)

  # Email (docs/guides/email.md): invites, password resets, sign-in codes and approval notices.
  email_env = { for k, v in {
    EMAIL_DRIVER                  = var.email.driver
    EMAIL_FROM                    = var.email.from
    EMAIL_REPLY_TO                = var.email.reply_to
    EMAIL_ALLOW_LOG_IN_PRODUCTION = var.email.driver == "log" ? "true" : null
  } : k => v if v != null }
  # The provider credential: the Resend API key, or an smtp(s):// URL with the SMTP user and password.
  email_secrets = var.email.secret_arn == null ? {} : { (var.email.driver == "smtp" ? "SMTP_URL" : "RESEND_API_KEY") = var.email.secret_arn }

  # Secrets Manager JSON keys injected at task start (<arn>:<key>::).
  api_secrets = merge({
    DATABASE_URL = "${local.bootstrap_arn}:DATABASE_URL::"
    # Must be stable across API tasks: a per-task generated token would make
    # first-run setup fail on every other request.
    OCSO_SETUP_TOKEN = "${local.bootstrap_arn}:OCSO_SETUP_TOKEN::"
    # The api reads the audit store through the SELECT-only reader.
    AUDIT_DATABASE_URL = "${local.bootstrap_arn}:AUDIT_READER_URL::"
    AUDIT_SIGNING_KEY  = var.audit_signing_key_secret_arn
    # Same value on every api task, or sessions signed by one task fail on the next.
    BETTER_AUTH_SECRET = aws_secretsmanager_secret.auth.arn
  }, local.email_secrets)
  worker_secrets = merge({
    DATABASE_URL       = "${local.bootstrap_arn}:DATABASE_URL::"
    AUDIT_DATABASE_URL = "${local.bootstrap_arn}:AUDIT_DATABASE_URL::"
    AUDIT_SIGNING_KEY  = var.audit_signing_key_secret_arn
  }, local.email_secrets)
  # The migrate task also provisions the audit store: owner credentials exist only here.
  migrate_secrets = {
    DATABASE_URL             = "${local.bootstrap_arn}:DATABASE_URL::"
    AUDIT_DATABASE_URL       = "${local.bootstrap_arn}:AUDIT_DATABASE_URL::"
    AUDIT_READER_URL         = "${local.bootstrap_arn}:AUDIT_READER_URL::"
    AUDIT_DATABASE_OWNER_URL = "${local.bootstrap_arn}:AUDIT_DATABASE_OWNER_URL::"
  }

  worker_capacity = var.worker.use_spot ? [
    { capacity_provider = "FARGATE", weight = 1, base = var.worker_scaling.min_capacity },
    { capacity_provider = "FARGATE_SPOT", weight = var.worker.spot_ratio, base = 0 },
  ] : [{ capacity_provider = "FARGATE", weight = 1, base = 0 }]
}
