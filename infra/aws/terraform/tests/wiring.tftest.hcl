mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["ap-south-1a", "ap-south-1b", "ap-south-1c"] }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012", arn = "arn:aws:iam::123456789012:root" }
  }
  mock_data "aws_region" {
    defaults = { region = "ap-south-1", name = "ap-south-1" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
}

variables {
  environment                  = "prod"
  aws_region                   = "ap-south-1"
  public_hostname              = "support.meridian.example"
  acm_certificate_arn          = "arn:aws:acm:ap-south-1:123456789012:certificate/abc"
  image_tag                    = "2026.09.25-1"
  audit_signing_key_secret_arn = "arn:aws:secretsmanager:ap-south-1:123456789012:secret:ocso/prod/audit-signing-key-AbCdEf"
  email = {
    driver     = "resend"
    from       = "Meridian OCSO <ocso@meridian.example>"
    secret_arn = "arn:aws:secretsmanager:ap-south-1:123456789012:secret:ocso/prod/email-AbCdEf"
  }
}

override_resource {
  target          = aws_secretsmanager_secret.auth
  override_during = plan
  values          = { arn = "arn:aws:secretsmanager:ap-south-1:123456789012:secret:ocso/prod/auth-secret-XyZ123" }
}

run "wiring" {
  command = plan
  assert {
    condition     = contains(var.queue_topics, "conversation.route")
    error_message = "conversation.route queue missing"
  }
  assert {
    condition     = local.api_secrets["BETTER_AUTH_SECRET"] == aws_secretsmanager_secret.auth.arn && local.api_secrets["RESEND_API_KEY"] == var.email.secret_arn && local.worker_secrets["RESEND_API_KEY"] == var.email.secret_arn
    error_message = "secrets not wired"
  }
  assert {
    condition     = local.app_env["EMAIL_DRIVER"] == "resend" && local.app_env["EMAIL_FROM"] == var.email.from && !contains(keys(local.app_env), "EMAIL_ALLOW_LOG_IN_PRODUCTION")
    error_message = "email env not wired"
  }
}

run "log_trial" {
  command = plan
  variables {
    email = { driver = "log" }
  }
  # The check warns on a plan and does not block it.
  expect_failures = [check.email_delivers]
  assert {
    condition     = local.app_env["EMAIL_ALLOW_LOG_IN_PRODUCTION"] == "true" && length(local.email_secrets) == 0
    error_message = "log driver not allowed"
  }
}

run "resend_needs_secret" {
  command = plan
  variables {
    email = { driver = "resend", from = "a@b.example" }
  }
  expect_failures = [var.email]
}
