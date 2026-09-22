# Secrets (ADR-012, research/05 §4).
#
# * `<prefix>/bootstrap` — JSON with DATABASE_URL, OCSO_INTERNAL_SIGNING_KEY and
#   OCSO_SETUP_TOKEN, injected into tasks by the ECS execution role. Written
#   with a write-only attribute so the values never enter Terraform state.
# * `<prefix>/app/*` — runtime secrets the application creates itself
#   (provider keys, channel tokens, MCP credentials) through the aws SecretStore
#   driver; PostgreSQL stores only their ARNs.
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  secret_arn_base    = "arn:${data.aws_partition.current.partition}:secretsmanager:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:secret"
  runtime_arn_prefix = "${local.secret_arn_base}:${var.prefix}/app/*"
}

resource "aws_kms_key" "this" {
  description             = "${var.name} bootstrap secrets"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "this" {
  name          = "alias/${var.name}-secrets"
  target_key_id = aws_kms_key.this.key_id
}

resource "aws_secretsmanager_secret" "bootstrap" {
  name                    = "${var.prefix}/bootstrap"
  description             = "OCSO bootstrap configuration (database URL, signing key, setup token). Rotate via bootstrap_secret_version."
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = var.recovery_window_days
}

resource "aws_secretsmanager_secret_version" "bootstrap" {
  secret_id                = aws_secretsmanager_secret.bootstrap.id
  secret_string_wo         = var.bootstrap_values
  secret_string_wo_version = var.bootstrap_version
}

# Execution role: read the bootstrap secret at task start, nothing else.
data "aws_iam_policy_document" "execution_read" {
  statement {
    sid       = "ReadBootstrapSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.bootstrap.arn]
  }
  statement {
    sid       = "DecryptBootstrapSecret"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.this.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${data.aws_region.current.region}.amazonaws.com"]
    }
  }
}

# Task role (api, worker): manage runtime secrets under <prefix>/app/ only.
# Secrets are created with the account's aws/secretsmanager key (the app does
# not pass a KMS key), which needs no extra KMS permissions.
data "aws_iam_policy_document" "runtime_manage" {
  statement {
    sid       = "CreateTaggedRuntimeSecrets"
    actions   = ["secretsmanager:CreateSecret"]
    resources = [local.runtime_arn_prefix]
    condition {
      test     = "Null"
      variable = "aws:RequestTag/ocso:kind"
      values   = ["false"]
    }
  }
  statement {
    sid = "UseRuntimeSecrets"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:PutSecretValue",
      "secretsmanager:DescribeSecret",
      "secretsmanager:DeleteSecret",
    ]
    resources = [local.runtime_arn_prefix]
  }
  statement {
    sid       = "TagRuntimeSecrets"
    actions   = ["secretsmanager:TagResource"]
    resources = [local.runtime_arn_prefix]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["ocso:ref", "ocso:kind"]
    }
  }
}
