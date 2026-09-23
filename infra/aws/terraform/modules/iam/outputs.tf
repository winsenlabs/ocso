output "execution_role_arns" {
  description = "Execution role ARNs: app (api/worker/migrate, reads the bootstrap secret) and web."
  value       = { for k, r in aws_iam_role.execution : k => r.arn }
}

output "task_role_arns" {
  description = "Task role ARNs by service (api, worker, web, migrate)."
  value       = { for k, r in aws_iam_role.task : k => r.arn }
}
