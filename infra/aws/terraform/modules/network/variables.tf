variable "name" {
  description = "Name prefix."
  type        = string
}

variable "region" {
  description = "AWS region (for endpoint service names)."
  type        = string
}

variable "cidr_block" {
  description = "VPC CIDR; split into /20 subnets (needs at least a /16)."
  type        = string
}

variable "az_count" {
  description = "Availability zones to span (2-3)."
  type        = number
}

variable "single_nat_gateway" {
  description = "Share one NAT gateway across AZs."
  type        = bool
  default     = false
}

variable "enable_s3_gateway_endpoint" {
  description = "Create the S3 gateway endpoint on private route tables."
  type        = bool
  default     = true
}
