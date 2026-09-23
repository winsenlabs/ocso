output "bootstrap_secret_arn" {
  description = "Bootstrap secret ARN (task definitions use <arn>:<json-key>::)."
  value       = aws_secretsmanager_secret.bootstrap.arn
}

output "kms_key_arn" {
  description = "CMK protecting the bootstrap secret."
  value       = aws_kms_key.this.arn
}

output "runtime_prefix" {
  description = "SECRETS_NAME_PREFIX for the application."
  value       = "${var.prefix}/app"
}

output "execution_read_policy_json" {
  description = "Policy for the execution role: read the bootstrap secret."
  value       = data.aws_iam_policy_document.execution_read.json
}

output "runtime_manage_policy_json" {
  description = "Policy for app task roles: manage runtime secrets under <prefix>/app/."
  value       = data.aws_iam_policy_document.runtime_manage.json
}
