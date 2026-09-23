variable "name" {
  description = "Name prefix."
  type        = string
}

variable "alarm_email_addresses" {
  description = "Email subscribers of the alarm topic."
  type        = list(string)
  default     = []
}

variable "alb_arn_suffix" {
  description = "ALB ARN suffix."
  type        = string
}

variable "target_group_arn_suffixes" {
  description = "Target group ARN suffixes keyed by service."
  type        = map(string)
}

variable "db_instance_identifier" {
  description = "RDS instance identifier."
  type        = string
}

variable "db_free_storage_threshold_gib" {
  description = "Free-storage alarm threshold (GiB)."
  type        = number
  default     = 10
}

variable "turn_queue_name" {
  description = "conversation.turn SQS queue name."
  type        = string
}

variable "turn_backlog_threshold_seconds" {
  description = "Oldest-turn age that pages someone."
  type        = number
  default     = 120
}

variable "otel_enabled" {
  description = "Create the EMF log group for the collector sidecar."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  description = "Retention for the EMF log group."
  type        = number
  default     = 30
}
