# PostgreSQL is OCSO's durable truth (build rule §5): encrypted with a CMK,
# private, TLS enforced, point-in-time recovery via automated backups.
resource "aws_kms_key" "this" {
  description             = "${var.name} RDS storage and Performance Insights"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "this" {
  name          = "alias/${var.name}-rds"
  target_key_id = aws_kms_key.this.key_id
}

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "this" {
  name        = "${var.name}-rds"
  description = "OCSO PostgreSQL: only the app task security groups"
  vpc_id      = var.vpc_id
  tags        = { Name = "${var.name}-rds" }
}

# Static map keys keep for_each plannable even though the SG ids are unknown.
resource "aws_vpc_security_group_ingress_rule" "clients" {
  for_each                     = var.client_security_group_ids
  security_group_id            = aws_security_group.this.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL from ${each.key}"
}

resource "aws_db_parameter_group" "this" {
  name_prefix = "${var.name}-pg-" # name_prefix: create_before_destroy needs a fresh name on replacement
  family      = var.parameter_group_family
  description = "OCSO PostgreSQL parameters"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000" # log statements slower than 1 s (no parameters are logged)
  }

  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "60000"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_db_instance" "this" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.this.arn

  db_name  = var.db_name
  username = var.username
  # Write-only: sent to RDS only when password_wo_version changes and never
  # stored in Terraform state (Terraform >= 1.11).
  password_wo         = var.password
  password_wo_version = var.password_version

  port                   = 5432
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.this.id]
  parameter_group_name   = aws_db_parameter_group.this.name
  publicly_accessible    = false
  multi_az               = var.multi_az
  ca_cert_identifier     = var.ca_cert_identifier

  backup_retention_period   = var.backup_retention_days
  backup_window             = var.backup_window
  maintenance_window        = var.maintenance_window
  copy_tags_to_snapshot     = true
  delete_automated_backups  = false
  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = "${var.name}-final"

  performance_insights_enabled          = var.performance_insights
  performance_insights_kms_key_id       = var.performance_insights ? aws_kms_key.this.arn : null
  performance_insights_retention_period = var.performance_insights ? 7 : null
  monitoring_interval                   = var.monitoring_interval_sec
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]

  auto_minor_version_upgrade  = var.auto_minor_upgrade
  allow_major_version_upgrade = false # major upgrades are a planned, tested change
  apply_immediately           = var.apply_immediately
}
