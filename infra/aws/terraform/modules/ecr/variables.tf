variable "name_prefix" {
  description = "Repository name prefix, e.g. \"ocso-\" gives ocso-api."
  type        = string
  default     = "ocso-"
}

variable "repositories" {
  description = "Repository suffixes (Dockerfile targets)."
  type        = list(string)
  default     = ["api", "worker", "web", "migrate"]
}

variable "keep_images" {
  description = "Tagged images kept per repository. Keep enough for rollback."
  type        = number
  default     = 30
}

variable "force_delete" {
  description = "Allow deleting repositories that still contain images."
  type        = bool
  default     = false
}
