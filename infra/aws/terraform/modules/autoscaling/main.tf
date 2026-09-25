# Worker autoscaling (docs/archive/specs/10 §6, ADR-023, research/05 §2). Scale on
# conversation demand and queue age, never on CPU alone.
#
#  1. Target tracking on metric math "slot demand per live worker" published by
#     OCSO under OCSO/Scaling (Service=worker). Target = conversations per
#     worker × target utilization.
#  2. Step scaling on the age of the oldest conversation.turn message, for
#     bursts and scale-from-floor (target tracking evaluates only per minute).
#
# OCSO's ECS deployment adapter (worker leader) owns min/max, the target
# value, cooldowns and thresholds at runtime (Tech Admin settings), so
# Terraform declares the shape and ignores those attributes afterwards. The
# adapter updates these policies by name (PutScalingPolicy is an upsert) and
# may manage alarms named "<name>-worker-*". With several policies, ECS scales
# out if any policy says so and in only when all agree.
resource "aws_appautoscaling_target" "worker" {
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${var.cluster_name}/${var.service_name}"
  min_capacity       = var.min_capacity
  max_capacity       = var.max_capacity

  lifecycle {
    ignore_changes = [min_capacity, max_capacity, suspended_state]
  }
}

resource "aws_appautoscaling_policy" "demand" {
  name               = "${var.name}-worker-slot-demand"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.worker.service_namespace
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension
  resource_id        = aws_appautoscaling_target.worker.resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = var.conversations_per_worker * var.target_utilization
    scale_out_cooldown = var.scale_out_cooldown
    scale_in_cooldown  = var.scale_in_cooldown

    # ADR-023: validate this expression with GetMetricData against real
    # published data before relying on it in production.
    customized_metric_specification {
      metrics {
        id          = "demand"
        label       = "Active plus queued conversations"
        return_data = false
        metric_stat {
          stat = "Sum"
          metric {
            namespace   = var.metric_namespace
            metric_name = "SlotDemand"
            dimensions {
              name  = "Service"
              value = var.metric_service_dimension
            }
          }
        }
      }
      metrics {
        id          = "workers"
        label       = "Workers with a fresh heartbeat"
        return_data = false
        metric_stat {
          stat = "Average"
          metric {
            namespace   = var.metric_namespace
            metric_name = "Workers"
            dimensions {
              name  = "Service"
              value = var.metric_service_dimension
            }
          }
        }
      }
      metrics {
        id          = "perworker"
        label       = "Slot demand per worker"
        expression  = "IF(workers > 0, demand / workers, demand)"
        return_data = true
      }
    }
  }

  lifecycle {
    ignore_changes = [target_tracking_scaling_policy_configuration]
  }
}

resource "aws_appautoscaling_policy" "queue_age" {
  name               = "${var.name}-worker-queue-age"
  policy_type        = "StepScaling"
  service_namespace  = aws_appautoscaling_target.worker.service_namespace
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension
  resource_id        = aws_appautoscaling_target.worker.resource_id

  # Bounds are relative to the alarm threshold: [T, T+60s) → +1, ≥ T+60s → +3.
  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = var.scale_out_cooldown
    metric_aggregation_type = "Maximum"

    step_adjustment {
      metric_interval_lower_bound = 0
      metric_interval_upper_bound = 60
      scaling_adjustment          = 1
    }
    step_adjustment {
      metric_interval_lower_bound = 60
      scaling_adjustment          = 3
    }
  }

  lifecycle {
    ignore_changes = [step_scaling_policy_configuration]
  }
}

resource "aws_cloudwatch_metric_alarm" "queue_age" {
  alarm_name          = "${var.name}-worker-queue-age-high"
  alarm_description   = "Oldest conversation.turn wake-up is waiting; scale workers out."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = var.turn_queue_name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = var.queue_age_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching" # the metric only exists while messages are queued
  alarm_actions       = [aws_appautoscaling_policy.queue_age.arn]

  lifecycle {
    ignore_changes = [threshold]
  }
}
