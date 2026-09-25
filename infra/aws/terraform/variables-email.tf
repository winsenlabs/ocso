variable "email" {
  description = <<-EOT
    How OCSO sends email: invites, password resets, sign-in codes and approval notices (docs/guides/email.md).
    Production refuses to start without a choice.
      driver     "resend" or "smtp" deliver; "log" delivers nothing (a trial only: nobody receives invites or resets).
      from       Sender on a domain verified with your provider, e.g. "Meridian OCSO <ocso@meridian.example>".
      reply_to   Optional reply-to address.
      secret_arn Secrets Manager secret, created outside Terraform, holding the Resend API key (resend) or an
                 smtps://user:password@host:465 URL (smtp).
      kms_key_arn Customer-managed KMS key encrypting that secret, if any.
  EOT
  type = object({
    driver      = string
    from        = optional(string)
    reply_to    = optional(string)
    secret_arn  = optional(string)
    kms_key_arn = optional(string)
  })
  validation {
    condition     = contains(["resend", "smtp", "log"], var.email.driver)
    error_message = "email.driver must be resend, smtp or log."
  }
  validation {
    condition     = var.email.driver == "log" || (var.email.from != null && var.email.secret_arn != null)
    error_message = "email.driver resend or smtp needs email.from and email.secret_arn."
  }
  validation {
    condition     = var.email.secret_arn == null || can(regex("^arn:aws[a-z-]*:secretsmanager:", var.email.secret_arn))
    error_message = "email.secret_arn must be a Secrets Manager secret ARN."
  }
}

check "email_delivers" {
  assert {
    condition     = var.email.driver != "log"
    error_message = "email.driver = log: OCSO starts, but invites, password resets and sign-in codes are not delivered."
  }
}

# The provider credential lives in its own secret; the app execution role may read it at task start.
data "aws_iam_policy_document" "email_secret_read" {
  count = var.email.secret_arn == null ? 0 : 1
  statement {
    sid       = "ReadEmailSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.email.secret_arn]
  }
  dynamic "statement" {
    for_each = var.email.kms_key_arn == null ? [] : [var.email.kms_key_arn]
    content {
      sid       = "DecryptEmailSecret"
      actions   = ["kms:Decrypt"]
      resources = [statement.value]
    }
  }
}

resource "aws_iam_role_policy" "email_secret_read" {
  count  = var.email.secret_arn == null ? 0 : 1
  name   = "email-secret"
  role   = regex("[^/]+$", module.iam.execution_role_arns["app"])
  policy = data.aws_iam_policy_document.email_secret_read[0].json
}
