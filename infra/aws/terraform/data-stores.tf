# Queues, media bucket, database and bootstrap secrets.

module "sqs" {
  source                     = "./modules/sqs"
  name                       = local.prefix
  topics                     = var.queue_topics
  max_receive_count          = var.sqs.max_receive_count
  visibility_timeout_seconds = var.sqs.visibility_timeout_seconds
  message_retention_seconds  = var.sqs.message_retention_seconds
  alarm_actions              = [module.observability.alarm_topic_arn]
}

module "s3" {
  source                          = "./modules/s3"
  name                            = local.prefix
  bucket_name                     = "${local.prefix}-media-${data.aws_caller_identity.current.account_id}"
  cors_allowed_origins            = concat([local.public_url], var.media.extra_cors_allowed_origins)
  temp_expiry_days                = var.media.temp_expiry_days
  noncurrent_expiry_days          = var.media.noncurrent_expiry_days
  abort_incomplete_multipart_days = var.media.abort_incomplete_multipart_days
  force_destroy                   = var.media.force_destroy
}

# ---------------------------------------------------------------------------
# Bootstrap credentials. Ephemeral values are generated on every run but are
# only *sent* when bootstrap_secret_version changes, and the same run feeds
# both RDS and the secret — so they always agree and never touch state.
# Alphanumeric only, so DATABASE_URL needs no percent-encoding.
# ---------------------------------------------------------------------------
ephemeral "random_password" "db" {
  length  = 40
  special = false
}

ephemeral "random_password" "setup_token" {
  length  = 40
  special = false
}

# The audit store's writer (worker, INSERT/SELECT) and reader (api, SELECT) roles; the migrate task creates both.
ephemeral "random_password" "audit_writer" {
  length  = 40
  special = false
}

ephemeral "random_password" "audit_reader" {
  length  = 40
  special = false
}

module "rds" {
  source = "./modules/rds"
  name   = local.prefix
  vpc_id = module.network.vpc_id

  subnet_ids = module.network.private_subnet_ids
  client_security_group_ids = {
    api     = aws_security_group.task["api"].id
    worker  = aws_security_group.task["worker"].id
    migrate = aws_security_group.task["migrate"].id
  }

  engine_version          = var.db.engine_version
  parameter_group_family  = var.db.parameter_group_family
  instance_class          = var.db.instance_class
  allocated_storage       = var.db.allocated_storage
  max_allocated_storage   = var.db.max_allocated_storage
  multi_az                = var.db.multi_az
  backup_retention_days   = var.db.backup_retention_days
  backup_window           = var.db.backup_window
  maintenance_window      = var.db.maintenance_window
  deletion_protection     = var.db.deletion_protection
  skip_final_snapshot     = var.db.skip_final_snapshot
  performance_insights    = var.db.performance_insights
  monitoring_interval_sec = var.db.monitoring_interval_sec
  ca_cert_identifier      = var.db.ca_cert_identifier
  auto_minor_upgrade      = var.db.auto_minor_upgrade
  apply_immediately       = var.db.apply_immediately

  password         = ephemeral.random_password.db.result
  password_version = var.bootstrap_secret_version
}

module "secrets" {
  source = "./modules/secrets"
  name   = local.prefix
  prefix = local.secrets_prefix

  bootstrap_version = var.bootstrap_secret_version
  bootstrap_values = jsonencode({
    DATABASE_URL     = "postgres://${module.rds.username}:${ephemeral.random_password.db.result}@${module.rds.address}:${module.rds.port}/${module.rds.db_name}"
    OCSO_SETUP_TOKEN = ephemeral.random_password.setup_token.result
    # Audit store (ADR-032; audit.tf): the writer URL (worker), the reader URL (api) and the owner
    # URL only the migrate task gets — the audit instance's own master unless separate_instance = false.
    AUDIT_DATABASE_URL = "postgres://ocso_audit_writer:${ephemeral.random_password.audit_writer.result}@${local.audit_host}/${var.audit_database_name}"
    AUDIT_READER_URL   = "postgres://ocso_audit_reader:${ephemeral.random_password.audit_reader.result}@${local.audit_host}/${var.audit_database_name}"
    AUDIT_DATABASE_OWNER_URL = (var.audit_store.separate_instance
      ? "postgres://ocso_audit:${ephemeral.random_password.audit_owner.result}@${local.audit_host}/${var.audit_database_name}"
    : "postgres://${module.rds.username}:${ephemeral.random_password.db.result}@${local.audit_host}/${var.audit_database_name}")
  })
}
