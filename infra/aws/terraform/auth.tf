# BETTER_AUTH_SECRET: signs staff sessions and encrypts authenticator secrets and backup codes. It has its own secret
# and version: rotating it signs everyone out and breaks enrolled authenticators, so it never follows
# bootstrap_secret_version (a database password rotation). Written with a write-only attribute, never in state.
ephemeral "random_password" "auth_secret" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "auth" {
  name                    = "${local.secrets_prefix}/auth-secret"
  description             = "OCSO BETTER_AUTH_SECRET (sessions, authenticator secrets, backup codes). Rotate only via auth_secret_version."
  kms_key_id              = module.secrets.kms_key_arn
  recovery_window_in_days = 30
}

resource "aws_secretsmanager_secret_version" "auth" {
  secret_id                = aws_secretsmanager_secret.auth.id
  secret_string_wo         = ephemeral.random_password.auth_secret.result
  secret_string_wo_version = var.auth_secret_version
}

data "aws_iam_policy_document" "auth_secret_read" {
  statement {
    sid       = "ReadAuthSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.auth.arn]
  }
  statement {
    sid       = "DecryptAuthSecret"
    actions   = ["kms:Decrypt"]
    resources = [module.secrets.kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.aws_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "auth_secret_read" {
  name   = "auth-secret"
  role   = regex("[^/]+$", module.iam.execution_role_arns["app"])
  policy = data.aws_iam_policy_document.auth_secret_read.json
}
