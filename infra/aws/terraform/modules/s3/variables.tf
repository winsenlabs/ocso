variable "name" {
  description = "Name prefix (KMS alias)."
  type        = string
}

variable "bucket_name" {
  description = "Globally unique bucket name."
  type        = string
}

variable "cors_allowed_origins" {
  description = "Origins allowed to use presigned URLs from a browser (the public OCSO origin)."
  type        = list(string)
}

variable "temp_expiry_days" {
  description = "Days before TEMP objects expire."
  type        = number
}

variable "noncurrent_expiry_days" {
  description = "Days noncurrent (overwritten/deleted) versions are kept."
  type        = number
}

variable "abort_incomplete_multipart_days" {
  description = "Days before incomplete multipart uploads are aborted."
  type        = number
}

variable "force_destroy" {
  description = "Allow destroying a non-empty bucket (never in production)."
  type        = bool
  default     = false
}
