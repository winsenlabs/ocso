# One SQS Standard queue + DLQ per OCSO topic (ADR-008). Messages are wake-up
# pointers; ordering and single-writer come from Postgres leases, so FIFO is
# deliberately not used (it cannot delay individual messages).
locals {
  # "conversation.turn" -> "ocso-prod-conversation-turn"
  queues = { for t in var.topics : t => "${var.name}-${replace(t, ".", "-")}" }
}

resource "aws_sqs_queue" "dlq" {
  for_each                  = local.queues
  name                      = "${each.value}-dlq"
  message_retention_seconds = 1209600 # 14 days: longer than the source (Standard keeps the enqueue time)
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "this" {
  for_each                   = local.queues
  name                       = each.value
  visibility_timeout_seconds = var.visibility_timeout_seconds # consumers also set it per receive
  message_retention_seconds  = var.message_retention_seconds
  receive_wait_time_seconds  = 20 # long polling by default
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = var.max_receive_count
  })
}

# Only the matching source queue may dead-letter into each DLQ.
resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  for_each  = local.queues
  queue_url = aws_sqs_queue.dlq[each.key].id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.this[each.key].arn]
  })
}

# Deny any non-TLS access to the queues.
data "aws_iam_policy_document" "tls_only" {
  for_each = local.queues

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["sqs:*"]
    resources = [aws_sqs_queue.this[each.key].arn, aws_sqs_queue.dlq[each.key].arn]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_sqs_queue_policy" "this" {
  for_each  = local.queues
  queue_url = aws_sqs_queue.this[each.key].id
  policy    = data.aws_iam_policy_document.tls_only[each.key].json
}

# Anything in a DLQ is a message OCSO gave up on: page someone.
resource "aws_cloudwatch_metric_alarm" "dlq_depth" {
  for_each            = local.queues
  alarm_name          = "${each.value}-dlq-not-empty"
  alarm_description   = "Messages dead-lettered from ${each.key}. Inspect, fix, then redrive (docs/operations/aws.md)."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.dlq[each.key].name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  ok_actions          = var.alarm_actions
}
