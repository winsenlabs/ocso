# The audit store (ADR-032): the system of record for audit events, in its own
# database. By default on its own RDS instance whose master credentials only the
# migrate task holds: the api/worker database credentials (the main instance's
# master user) cannot reach it. The worker connects as the INSERT/SELECT-only
# writer, the api as the SELECT-only reader; the migrate task creates both.
# `separate_instance = false` puts it on the main instance instead — cheaper, but
# then the main master user (which the api and worker hold) can alter the audit
# database, so append-only is not enforced against a compromised api (plan warns).

variable "audit_database_name" {
  description = "Database for the audit store (created by the migrate task when missing)."
  type        = string
  default     = "ocso_audit"
  validation {
    condition     = can(regex("^[a-z_][a-z0-9_]{0,62}$", var.audit_database_name))
    error_message = "audit_database_name must be a lower-case identifier."
  }
}

variable "audit_store" {
  description = "Where the audit store lives: its own RDS instance (default) or the main one, and that instance's size."
  type = object({
    separate_instance     = optional(bool, true)
    instance_class        = optional(string, "db.t4g.small")
    allocated_storage     = optional(number, 20)
    max_allocated_storage = optional(number, 200)
    multi_az              = optional(bool, true)
    backup_retention_days = optional(number, 35)
    # The store's own minimum retention: no purge removes anything younger (≥ 365; 2555 = 7 years).
    min_retention_days = optional(number, 365)
  })
  default = {}
  validation {
    condition     = var.audit_store.min_retention_days >= 365
    error_message = "audit_store.min_retention_days must be at least 365."
  }
}

variable "audit_signing_key_secret_arn" {
  description = <<-EOT
    ARN of a Secrets Manager secret holding the Ed25519 private key (PKCS#8 PEM) that signs
    audit checkpoints, exports and exception reports; required. Create it once, outside
    Terraform, so it never follows bootstrap_secret_version rotations and never enters state:
      openssl genpkey -algorithm ed25519 -out audit_signing_key.pem
      aws secretsmanager create-secret --name ocso/prod/audit-signing-key --secret-string file://audit_signing_key.pem
    Keep a copy with your backups. When you rotate it, keep the old public key in
    audit_trusted_public_keys so older checkpoints still verify.
  EOT
  type        = string
  validation {
    condition     = can(regex("^arn:aws[a-z-]*:secretsmanager:", var.audit_signing_key_secret_arn))
    error_message = "audit_signing_key_secret_arn must be a Secrets Manager secret ARN."
  }
}

variable "audit_signing_key_kms_key_arn" {
  description = "Customer-managed KMS key encrypting the signing key secret, if any (null = the AWS managed key)."
  type        = string
  default     = null
}

variable "audit_trusted_public_keys" {
  description = "Retired audit signing public keys (concatenated SPKI PEMs) that older checkpoints and exports verify against."
  type        = string
  default     = ""
}
