variable "name" {
  description = "Instance identifier / name prefix."
  type        = string
}

variable "vpc_id" {
  description = "VPC id."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnets for the DB subnet group."
  type        = list(string)
}

variable "client_security_group_ids" {
  description = "Security groups allowed to connect, keyed by a static label (api, worker, migrate)."
  type        = map(string)
}

variable "engine_version" {
  description = "PostgreSQL version; a major version (\"18\") lets RDS pick the default minor."
  type        = string
}

variable "parameter_group_family" {
  description = "Parameter group family matching the major version, e.g. postgres18."
  type        = string
}

variable "instance_class" {
  description = "DB instance class."
  type        = string
}

variable "allocated_storage" {
  description = "Initial storage (GiB)."
  type        = number
}

variable "max_allocated_storage" {
  description = "Storage autoscaling ceiling (GiB)."
  type        = number
}

variable "multi_az" {
  description = "Synchronous standby in a second AZ."
  type        = bool
}

variable "backup_retention_days" {
  description = "Automated backup (PITR) retention in days."
  type        = number
}

variable "backup_window" {
  description = "Daily backup window (UTC)."
  type        = string
}

variable "maintenance_window" {
  description = "Weekly maintenance window (UTC)."
  type        = string
}

variable "deletion_protection" {
  description = "Block deletion."
  type        = bool
}

variable "skip_final_snapshot" {
  description = "Skip the final snapshot on destroy."
  type        = bool
}

variable "performance_insights" {
  description = "Enable Performance Insights."
  type        = bool
}

variable "monitoring_interval_sec" {
  description = "Enhanced monitoring interval (0 disables; non-zero needs a monitoring role — not created here)."
  type        = number
}

variable "ca_cert_identifier" {
  description = "Server certificate CA (clients trust it via the RDS global bundle in the image)."
  type        = string
}

variable "auto_minor_upgrade" {
  description = "Apply minor versions in the maintenance window."
  type        = bool
}

variable "apply_immediately" {
  description = "Apply modifications immediately instead of in the maintenance window."
  type        = bool
}

variable "db_name" {
  description = "Initial database name."
  type        = string
  default     = "ocso"
}

variable "username" {
  description = "Master user name used by the application."
  type        = string
  default     = "ocso"
}

variable "password" {
  description = "Master password (ephemeral; used by the write-only attribute only)."
  type        = string
  ephemeral   = true
}

variable "password_version" {
  description = "Bump to push a new password."
  type        = number
}
