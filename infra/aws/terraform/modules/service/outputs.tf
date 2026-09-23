output "service_name" {
  description = "ECS service name (null when the service is not created)."
  value       = var.create_service ? aws_ecs_service.this[0].name : null
}

output "task_definition_arn" {
  description = "Current task definition revision ARN."
  value       = aws_ecs_task_definition.this.arn
}

output "family" {
  description = "Task definition family."
  value       = aws_ecs_task_definition.this.family
}

output "log_group_name" {
  description = "CloudWatch log group of the service."
  value       = aws_cloudwatch_log_group.this.name
}
