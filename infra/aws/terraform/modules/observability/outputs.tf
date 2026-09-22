output "alarm_topic_arn" {
  description = "SNS topic that receives infrastructure alarms."
  value       = aws_sns_topic.alarms.arn
}

output "otel_metrics_log_group_name" {
  description = "EMF log group for the collector sidecar (null when disabled)."
  value       = var.otel_enabled ? aws_cloudwatch_log_group.otel_metrics[0].name : null
}

output "otel_metrics_log_group_arn" {
  description = "EMF log group ARN (null when disabled)."
  value       = var.otel_enabled ? aws_cloudwatch_log_group.otel_metrics[0].arn : null
}
