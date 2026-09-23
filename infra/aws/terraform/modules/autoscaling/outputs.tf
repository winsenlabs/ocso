output "scalable_target_arn" {
  description = "Scalable target ARN (IAM resource for Register/PutScalingPolicy/DeleteScalingPolicy)."
  value       = aws_appautoscaling_target.worker.arn
}

output "resource_id" {
  description = "Scalable target resource id."
  value       = aws_appautoscaling_target.worker.resource_id
}

output "policy_names" {
  description = "Scaling policy names (the OCSO ECS deployment adapter updates these by name)."
  value = {
    demand    = aws_appautoscaling_policy.demand.name
    queue_age = aws_appautoscaling_policy.queue_age.name
  }
}

output "queue_age_alarm_name" {
  description = "Step-scaling alarm name."
  value       = aws_cloudwatch_metric_alarm.queue_age.alarm_name
}
