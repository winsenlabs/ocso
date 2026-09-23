variable "name" {
  description = "Name prefix (KMS alias)."
  type        = string
}

variable "prefix" {
  description = "Secrets Manager name prefix, e.g. ocso/prod."
  type        = string
}

variable "bootstrap_values" {
  description = "JSON document for the bootstrap secret (ephemeral; written via secret_string_wo)."
  type        = string
  ephemeral   = true
}

variable "bootstrap_version" {
  description = "Bump to write new bootstrap values."
  type        = number
}

variable "recovery_window_days" {
  description = "Days a deleted secret can be restored."
  type        = number
  default     = 30
}
