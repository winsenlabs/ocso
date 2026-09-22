variable "name" {
  description = "Name prefix for roles and alarm names."
  type        = string
}

variable "cluster_name" {
  description = "ECS cluster name (scopes worker service / task ARNs)."
  type        = string
}

variable "worker_service_name" {
  description = "Worker ECS service name."
  type        = string
}

variable "queue_arns" {
  description = "OCSO source queue ARNs."
  type        = list(string)
}

variable "dlq_arns" {
  description = "Dead-letter queue ARNs (read-only stats)."
  type        = list(string)
}

variable "media_bucket_arn" {
  description = "Media bucket ARN."
  type        = string
}

variable "media_kms_key_arn" {
  description = "Media bucket CMK ARN."
  type        = string
}

variable "execution_secret_policy_json" {
  description = "Policy letting the app execution role read the bootstrap secret."
  type        = string
}

variable "runtime_secrets_policy_json" {
  description = "Policy letting api/worker manage runtime secrets under the app prefix."
  type        = string
}

variable "metric_namespace" {
  description = "CloudWatch namespace the worker may publish scaling metrics to (OCSO_METRICS_NAMESPACE)."
  type        = string
}

variable "alarm_name_prefix" {
  description = "Alarm name prefix the worker's deployment adapter may create/update/delete, e.g. ocso-prod-worker-."
  type        = string
}

variable "worker_scalable_target_arn" {
  description = "ARN of the worker's Application Auto Scaling target (null until the worker service exists)."
  type        = string
  default     = null
}

variable "otel_enabled" {
  description = "Grant collector sidecar permissions."
  type        = bool
  default     = false
}

variable "otel_metrics_log_group_arn" {
  description = "Log group receiving EMF metrics from the collector."
  type        = string
  default     = null
}

variable "enable_execute_command" {
  description = "Grant ECS Exec (SSM Messages) permissions."
  type        = bool
  default     = false
}

variable "bedrock_model_arns" {
  description = "Bedrock foundation-model / inference-profile ARNs the api and worker task roles may invoke (Bedrock provider with authMode IAM_ROLE). Empty = no Bedrock permissions."
  type        = list(string)
  default     = []
}
