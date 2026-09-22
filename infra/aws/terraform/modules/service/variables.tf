variable "name" {
  description = "Service and container name (api, web, worker)."
  type        = string
}

variable "family" {
  description = "Task definition family (account-unique), e.g. ocso-prod-api."
  type        = string
}

variable "region" {
  description = "AWS region (log driver)."
  type        = string
}

variable "cluster_arn" {
  description = "ECS cluster ARN."
  type        = string
}

variable "image" {
  description = "Full image reference (repository:tag)."
  type        = string
}

variable "command" {
  description = "Override the image CMD (the image ENTRYPOINT is kept)."
  type        = list(string)
  default     = null
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
  description = "X86_64 or ARM64; must match the image."
  type        = string
}

variable "environment" {
  description = "Plain environment variables (never secrets)."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Environment variables resolved from Secrets Manager at task start: NAME => valueFrom ARN (optionally :json-key::)."
  type        = map(string)
  default     = {}
}

variable "container_port" {
  description = "Port the container listens on for traffic (null for none)."
  type        = number
  default     = null
}

variable "port_name" {
  description = "Port mapping name (Service Connect refers to it)."
  type        = string
  default     = "http"
}

variable "health_check" {
  description = "Container health probe: HTTP GET on 127.0.0.1:<port><path>."
  type = object({
    port         = number
    path         = string
    start_period = number
  })
}

variable "stop_timeout" {
  description = "Seconds between SIGTERM and SIGKILL (Fargate max 120)."
  type        = number
  default     = 30
}

variable "execution_role_arn" {
  description = "Task execution role (image pull, logs, secret injection)."
  type        = string
}

variable "task_role_arn" {
  description = "Task role (the application's own AWS permissions)."
  type        = string
}

variable "subnet_ids" {
  description = "Subnets for the tasks (private)."
  type        = list(string)
}

variable "security_group_ids" {
  description = "Security groups for the tasks."
  type        = list(string)
}

variable "create_service" {
  description = "Create the ECS service (false keeps only the task definition)."
  type        = bool
  default     = true
}

variable "desired_count" {
  description = "Initial desired count (ignored after creation)."
  type        = number
  default     = 1
}

variable "capacity_provider_strategy" {
  description = "Capacity provider strategy."
  type = list(object({
    capacity_provider = string
    weight            = number
    base              = number
  }))
  default = [{ capacity_provider = "FARGATE", weight = 1, base = 0 }]
}

variable "load_balancer" {
  description = "Optional ALB target group registration."
  type = object({
    target_group_arn = string
  })
  default = null
}

variable "health_check_grace_period_seconds" {
  description = "Grace period before ALB health checks count (LB-attached services only)."
  type        = number
  default     = 60
}

variable "service_connect" {
  description = "Service Connect: namespace, and whether this service publishes <dns_name>:<container_port>."
  type = object({
    namespace_arn  = string
    publish        = bool
    discovery_name = optional(string)
    dns_name       = optional(string)
  })
  default = null
}

variable "deployment_minimum_healthy_percent" {
  description = "Rolling deployment lower bound."
  type        = number
  default     = 100
}

variable "deployment_maximum_percent" {
  description = "Rolling deployment upper bound (raise it for services with scale-in protected tasks)."
  type        = number
  default     = 200
}

variable "enable_execute_command" {
  description = "Allow ECS Exec."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  description = "Log group retention."
  type        = number
}

variable "otel_collector" {
  description = "Optional collector sidecar; `config` is the full collector YAML."
  type = object({
    enabled = bool
    image   = string
    config  = string
  })
  default = { enabled = false, image = "", config = "" }
}
