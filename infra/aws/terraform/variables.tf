# ---------------------------------------------------------------------------
# Identity and placement
# ---------------------------------------------------------------------------
variable "name" {
  description = "Application name; prefixes every resource (ocso-<environment>-…)."
  type        = string
  default     = "ocso"
}

variable "environment" {
  description = "Deployment environment label, e.g. prod or staging. One OCSO deployment = one organization (single-tenant)."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.environment))
    error_message = "environment must be 2-16 lower-case letters, digits or dashes."
  }
}

variable "aws_region" {
  description = "AWS region, e.g. ap-south-1."
  type        = string
}

variable "tags" {
  description = "Extra tags applied to every resource."
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------
variable "public_hostname" {
  description = "Public host name customers, providers and staff reach (e.g. support.example.com). Becomes OCSO_PUBLIC_URL=https://<host>."
  type        = string
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN (same region) covering public_hostname, used by the HTTPS listener."
  type        = string
}

variable "route53_zone_id" {
  description = "Optional Route 53 hosted zone id; when set, an alias record for public_hostname is created."
  type        = string
  default     = null
}

variable "alb_ingress_cidrs" {
  description = "CIDRs allowed to reach the ALB on 80/443."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "alb_idle_timeout_seconds" {
  description = "ALB idle timeout. Long enough for the realtime SSE stream between heartbeats."
  type        = number
  default     = 300
}

variable "alb_deletion_protection" {
  description = "Protect the ALB from deletion."
  type        = bool
  default     = true
}

variable "alb_access_logs_bucket" {
  description = "Optional S3 bucket for ALB access logs (must already allow the ELB log delivery principal)."
  type        = string
  default     = null
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------
variable "vpc_cidr" {
  description = "VPC CIDR block."
  type        = string
  default     = "10.40.0.0/16"
}

variable "az_count" {
  description = "Number of availability zones (2 or 3)."
  type        = number
  default     = 2
  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3."
  }
}

variable "single_nat_gateway" {
  description = "One shared NAT gateway (cheaper, one AZ is a single point of egress failure) instead of one per AZ."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Images and services
# ---------------------------------------------------------------------------
variable "image_tag" {
  description = "Image tag deployed for api, worker, web and migrate (ECR tags are immutable; use a release/git SHA)."
  type        = string
}

variable "ecr_name_prefix" {
  description = "ECR repository name prefix (default \"<name>-\", giving ocso-api …). Set e.g. \"ocso-staging-\" when several environments share an account, or manage ECR once and promote images."
  type        = string
  default     = null
}

variable "ecr_keep_images" {
  description = "Tagged images kept per ECR repository."
  type        = number
  default     = 30
}

variable "cpu_architecture" {
  description = "Fargate CPU architecture; must match the pushed images (X86_64 or ARM64)."
  type        = string
  default     = "X86_64"
  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture must be X86_64 or ARM64."
  }
}

variable "deploy_services" {
  description = "Create the ECS services. Set false on the very first apply, run the migrate task, then apply again with true."
  type        = bool
  default     = true
}

variable "api" {
  description = "API service sizing. desired_count is only used at creation (later changes are ignored)."
  type = object({
    cpu           = number
    memory        = number
    desired_count = number
  })
  default = { cpu = 1024, memory = 2048, desired_count = 2 }
}

variable "web" {
  description = "Web (Next.js) service sizing."
  type = object({
    cpu           = number
    memory        = number
    desired_count = number
  })
  default = { cpu = 512, memory = 1024, desired_count = 2 }
}

variable "worker" {
  description = "Worker task sizing. Count is owned by autoscaling."
  type = object({
    cpu        = number
    memory     = number
    use_spot   = bool # add FARGATE_SPOT to the worker strategy (tasks can be reclaimed with 2 min notice)
    spot_ratio = number
  })
  default = { cpu = 1024, memory = 2048, use_spot = false, spot_ratio = 1 }
}

variable "migrate" {
  description = "Migration one-off task sizing."
  type = object({
    cpu    = number
    memory = number
  })
  default = { cpu = 256, memory = 512 }
}

variable "enable_execute_command" {
  description = "Allow `aws ecs execute-command` into app tasks (adds SSM Messages permissions)."
  type        = bool
  default     = false
}

variable "log_level" {
  description = "Application LOG_LEVEL."
  type        = string
  default     = "info"
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for container logs."
  type        = number
  default     = 30
}

variable "database_pool_size" {
  description = "DATABASE_POOL_SIZE per task. (api tasks + worker tasks) × pool must stay below RDS max_connections."
  type        = number
  default     = 10
}
