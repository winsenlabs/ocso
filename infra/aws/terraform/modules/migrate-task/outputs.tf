output "task_definition_arn" {
  description = "Migration task definition revision ARN (pass to `aws ecs run-task`)."
  value       = aws_ecs_task_definition.this.arn
}

output "family" {
  description = "Task definition family."
  value       = aws_ecs_task_definition.this.family
}

output "log_group_name" {
  description = "Log group with migration output."
  value       = aws_cloudwatch_log_group.this.name
}
