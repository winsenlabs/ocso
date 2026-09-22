# Permissions that exist only when the matching feature is enabled.

# Collector sidecar (api and worker only; web has no OTel SDK): traces to the X-Ray OTLP endpoint (AWS keeps this managed
# policy current with the OTLP span actions) and EMF metrics into one log group.
resource "aws_iam_role_policy_attachment" "otel_xray" {
  for_each   = var.otel_enabled ? toset(["api", "worker"]) : toset([])
  role       = aws_iam_role.task[each.key].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AWSXrayWriteOnlyAccess"
}

data "aws_iam_policy_document" "otel_emf" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = [var.otel_metrics_log_group_arn == null ? "arn:${local.partition}:logs:${local.region}:${local.account}:log-group:none" : "${var.otel_metrics_log_group_arn}:*"]
  }
}

resource "aws_iam_role_policy" "otel_emf" {
  for_each = var.otel_enabled ? toset(["api", "worker"]) : toset([])
  name     = "otel-emf"
  role     = aws_iam_role.task[each.key].name
  policy   = data.aws_iam_policy_document.otel_emf.json
}

# ECS Exec (break-glass shell). Off by default; every session is logged by SSM.
data "aws_iam_policy_document" "exec" {
  statement {
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "exec" {
  for_each = var.enable_execute_command ? toset(["api", "worker", "web"]) : toset([])
  name     = "ecs-exec"
  role     = aws_iam_role.task[each.key].name
  policy   = data.aws_iam_policy_document.exec.json
}
