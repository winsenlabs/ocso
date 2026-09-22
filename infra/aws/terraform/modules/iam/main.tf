# Least-privilege roles for the OCSO tasks.
#   execution roles: pull images, write logs, inject the bootstrap secret (app only)
#   task roles:      what the application code itself may call
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  partition = data.aws_partition.current.partition
  region    = data.aws_region.current.region
  account   = data.aws_caller_identity.current.account_id

  worker_service_arn = "arn:${local.partition}:ecs:${local.region}:${local.account}:service/${var.cluster_name}/${var.worker_service_name}"
  cluster_tasks_arn  = "arn:${local.partition}:ecs:${local.region}:${local.account}:task/${var.cluster_name}/*"
  alarm_arn_prefix   = "arn:${local.partition}:cloudwatch:${local.region}:${local.account}:alarm"

  task_roles = toset(["api", "worker", "web", "migrate"])
}

# Confused-deputy protection: only ECS tasks in this account may assume.
data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:ecs:${local.region}:${local.account}:*"]
    }
  }
}

# ----------------------------------------------------------------------------
# Execution roles
# ----------------------------------------------------------------------------
resource "aws_iam_role" "execution" {
  for_each           = toset(["app", "web"])
  name               = "${var.name}-exec-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

resource "aws_iam_role_policy_attachment" "execution_base" {
  for_each   = aws_iam_role.execution
  role       = each.value.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Only api/worker/migrate receive database credentials; web never does.
resource "aws_iam_role_policy" "execution_app_secrets" {
  name   = "bootstrap-secret"
  role   = aws_iam_role.execution["app"].name
  policy = var.execution_secret_policy_json
}

# ----------------------------------------------------------------------------
# Task roles
# ----------------------------------------------------------------------------
resource "aws_iam_role" "task" {
  for_each           = local.task_roles
  name               = "${var.name}-task-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

# api + worker: queues, media bucket, runtime secrets.
data "aws_iam_policy_document" "app_common" {
  statement {
    sid = "Queues"
    actions = [
      "sqs:SendMessage",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
    ]
    resources = var.queue_arns
  }
  statement {
    sid       = "DeadLetterStats"
    actions   = ["sqs:GetQueueAttributes", "sqs:GetQueueUrl"]
    resources = var.dlq_arns
  }
  statement {
    sid       = "MediaObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"]
    resources = ["${var.media_bucket_arn}/*"]
  }
  statement {
    sid       = "MediaList" # HeadObject on a missing key returns 404 (not 403) only with ListBucket
    actions   = ["s3:ListBucket"]
    resources = [var.media_bucket_arn]
  }
  statement {
    sid       = "MediaKey"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.media_kms_key_arn]
  }
}

resource "aws_iam_role_policy" "app_common" {
  for_each = toset(["api", "worker"])
  name     = "ocso-app"
  role     = aws_iam_role.task[each.key].name
  policy   = data.aws_iam_policy_document.app_common.json
}

resource "aws_iam_role_policy" "runtime_secrets" {
  for_each = toset(["api", "worker"])
  name     = "runtime-secrets"
  role     = aws_iam_role.task[each.key].name
  policy   = var.runtime_secrets_policy_json
}

# Worker scaling and task protection are in scaling.tf (same module).
