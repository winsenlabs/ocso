# Worker task role: OCSO's ECS deployment adapter runs in the worker leader
# (ADR-018 leadership, ADR-023). It publishes scaling metrics, maps Tech Admin
# worker settings onto the worker's scalable target, policies and step-scaling
# alarms, and toggles scale-in protection while a turn runs. The API task
# role gets none of this.
#
# Registering a scalable target needs the service-linked role
# AWSServiceRoleForApplicationAutoScaling_ECSService. AWS creates it the
# first time a target is registered (here: by Terraform's aws_appautoscaling_target,
# using the deployer's credentials), so the worker never needs
# iam:CreateServiceLinkedRole.
data "aws_iam_policy_document" "worker_scaling" {
  # Mutating calls support resource-level permissions on the scalable-target
  # ARN (Terraform-created, so it is known here).
  dynamic "statement" {
    for_each = var.worker_scalable_target_arn == null ? [] : [var.worker_scalable_target_arn]
    content {
      sid = "WorkerScalableTarget"
      actions = [
        "application-autoscaling:RegisterScalableTarget",
        "application-autoscaling:PutScalingPolicy",
        "application-autoscaling:DeleteScalingPolicy",
      ]
      resources = [statement.value]
    }
  }

  # Describe* actions have no resource types; they are read-only.
  statement {
    sid = "DescribeAutoscaling"
    actions = [
      "application-autoscaling:DescribeScalableTargets",
      "application-autoscaling:DescribeScalingPolicies",
      "application-autoscaling:DescribeScalingActivities",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "DescribeWorkerService"
    actions   = ["ecs:DescribeServices"]
    resources = [local.worker_service_arn]
  }

  statement {
    sid       = "PublishScalingMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"] # PutMetricData has no resource type; scoped by namespace
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [var.metric_namespace]
    }
  }

  # Step-scaling alarms the adapter owns: "<ECS_CLUSTER>-worker-…".
  statement {
    sid       = "ManageWorkerAlarms"
    actions   = ["cloudwatch:PutMetricAlarm", "cloudwatch:DeleteAlarms"]
    resources = ["${local.alarm_arn_prefix}:${var.alarm_name_prefix}*"]
  }

  # DescribeAlarms is read-only; a name-scoped resource would break prefix
  # listing calls, so it is left unscoped.
  statement {
    sid       = "DescribeAlarms"
    actions   = ["cloudwatch:DescribeAlarms"]
    resources = ["*"]
  }

  # Scale-in protection only while a turn is running (research/05 §2).
  statement {
    sid       = "TaskProtection"
    actions   = ["ecs:UpdateTaskProtection", "ecs:GetTaskProtection"]
    resources = [local.cluster_tasks_arn]
  }
}

resource "aws_iam_role_policy" "worker_scaling" {
  name   = "ecs-deployment-adapter"
  role   = aws_iam_role.task["worker"].name
  policy = data.aws_iam_policy_document.worker_scaling.json
}
