variable "family" {
  description = "Task definition family, e.g. ocso-prod-migrate."
  type        = string
}

variable "region" {
  description = "AWS region (log driver)."
  type        = string
}

variable "image" {
  description = "Migrate image reference (repository:tag)."
  type        = string
}

variable "cpu" {
  description = "Task CPU units."
  type        = number
}

variable "memory" {
  description = "Task memory (MiB)."
  type        = number
}

variable "cpu_architecture" {
  description = "X86_64 or ARM64."
  type        = string
}

variable "environment" {
  description = "Plain environment variables."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Secrets Manager injections (NAME => valueFrom)."
  type        = map(string)
  default     = {}
}

variable "execution_role_arn" {
  description = "Execution role (reads the bootstrap secret)."
  type        = string
}

variable "task_role_arn" {
  description = "Task role (no AWS permissions needed)."
  type        = string
}

variable "log_retention_days" {
  description = "Log retention."
  type        = number
}
