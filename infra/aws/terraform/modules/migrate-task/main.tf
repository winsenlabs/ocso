# One-off database migration task (docs/archive/specs/13 §5, ADR-004). Terraform only
# registers the task definition; the deploy pipeline runs it with
# `aws ecs run-task`, waits for it to stop and checks exit code 0 before any
# service is updated (docs/guides/deploy/aws.md).
resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${var.family}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "this" {
  family                   = var.family
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  # The image's default CMD applies the migrations and exits.
  container_definitions = jsonencode([{
    name        = "migrate"
    image       = var.image
    essential   = true
    environment = [for k, v in var.environment : { name = k, value = v }]
    secrets     = [for k, v in var.secrets : { name = k, valueFrom = v }]
    stopTimeout = 120 # let an in-flight migration transaction finish or roll back
    linuxParameters = {
      initProcessEnabled = true
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.this.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "migrate"
      }
    }
  }])
}
