variable "name" {
  description = "Name prefix (ALB and target group names are truncated to 32 characters)."
  type        = string
}

variable "vpc_id" {
  description = "VPC id."
  type        = string
}

variable "vpc_cidr_block" {
  description = "VPC CIDR (ALB egress is limited to it)."
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnets for the ALB."
  type        = list(string)
}

variable "certificate_arn" {
  description = "ACM certificate for the HTTPS listener."
  type        = string
}

variable "ssl_policy" {
  description = "TLS policy for the HTTPS listener."
  type        = string
  default     = "ELBSecurityPolicy-TLS13-1-2-2021-06"
}

variable "ingress_cidrs" {
  description = "CIDRs allowed on 80/443."
  type        = list(string)
}

variable "idle_timeout_seconds" {
  description = "Idle timeout (SSE streams need a generous value)."
  type        = number
}

variable "deletion_protection" {
  description = "Enable ALB deletion protection."
  type        = bool
}

variable "access_logs_bucket" {
  description = "Optional access log bucket."
  type        = string
  default     = null
}
