# The audit store's own RDS instance (ADR-032; variables-audit.tf). Its master
# user is the audit database owner and only the migrate task receives it.

ephemeral "random_password" "audit_owner" {
  length  = 40
  special = false
}

module "audit_rds" {
  count  = var.audit_store.separate_instance ? 1 : 0
  source = "./modules/rds"
  name   = "${local.prefix}-audit"
  vpc_id = module.network.vpc_id

  subnet_ids = module.network.private_subnet_ids
  client_security_group_ids = {
    api     = aws_security_group.task["api"].id
    worker  = aws_security_group.task["worker"].id
    migrate = aws_security_group.task["migrate"].id
  }

  engine_version          = var.db.engine_version
  parameter_group_family  = var.db.parameter_group_family
  instance_class          = var.audit_store.instance_class
  allocated_storage       = var.audit_store.allocated_storage
  max_allocated_storage   = var.audit_store.max_allocated_storage
  multi_az                = var.audit_store.multi_az
  backup_retention_days   = var.audit_store.backup_retention_days
  backup_window           = var.db.backup_window
  maintenance_window      = var.db.maintenance_window
  deletion_protection     = var.db.deletion_protection
  skip_final_snapshot     = var.db.skip_final_snapshot
  performance_insights    = var.db.performance_insights
  monitoring_interval_sec = var.db.monitoring_interval_sec
  ca_cert_identifier      = var.db.ca_cert_identifier
  auto_minor_upgrade      = var.db.auto_minor_upgrade
  apply_immediately       = var.db.apply_immediately

  db_name          = var.audit_database_name
  username         = "ocso_audit"
  password         = ephemeral.random_password.audit_owner.result
  password_version = var.bootstrap_secret_version
}

locals {
  audit_host = var.audit_store.separate_instance ? "${module.audit_rds[0].address}:${module.audit_rds[0].port}" : "${module.rds.address}:${module.rds.port}"
}

# Shared instance: the main master user (held by the api and worker) owns the audit database too.
check "audit_store_boundary" {
  assert {
    condition     = var.audit_store.separate_instance
    error_message = "audit_store.separate_instance = false: the api/worker database credentials can alter the audit database (append-only is not enforced against a compromised api). Use a separate instance for a bank deployment (docs/15 §7)."
  }
}

# The signing key lives in its own secret (created outside Terraform); the app execution role may read it.
data "aws_iam_policy_document" "audit_signing_key_read" {
  statement {
    sid       = "ReadAuditSigningKey"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.audit_signing_key_secret_arn]
  }
  dynamic "statement" {
    for_each = var.audit_signing_key_kms_key_arn == null ? [] : [var.audit_signing_key_kms_key_arn]
    content {
      sid       = "DecryptAuditSigningKey"
      actions   = ["kms:Decrypt"]
      resources = [statement.value]
    }
  }
}

resource "aws_iam_role_policy" "audit_signing_key_read" {
  name   = "audit-signing-key"
  role   = regex("[^/]+$", module.iam.execution_role_arns["app"])
  policy = data.aws_iam_policy_document.audit_signing_key_read.json
}
