# Generic Fargate service, reused for web, api and worker (ADR-022).
# The task definition always exists; the service is optional so the first
# apply can create everything, run migrations, and only then start services.
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
  container_definitions    = jsonencode(local.container_definitions)

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }
}

resource "aws_ecs_service" "this" {
  count = var.create_service ? 1 : 0

  name                   = var.name
  cluster                = var.cluster_arn
  task_definition        = aws_ecs_task_definition.this.arn
  desired_count          = var.desired_count
  enable_execute_command = var.enable_execute_command
  propagate_tags         = "SERVICE"
  # Only meaningful with a load balancer; gives slow starts time before ALB checks count.
  health_check_grace_period_seconds  = var.load_balancer == null ? null : var.health_check_grace_period_seconds
  deployment_minimum_healthy_percent = var.deployment_minimum_healthy_percent
  deployment_maximum_percent         = var.deployment_maximum_percent
  enable_ecs_managed_tags            = true

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  dynamic "capacity_provider_strategy" {
    for_each = var.capacity_provider_strategy
    content {
      capacity_provider = capacity_provider_strategy.value.capacity_provider
      weight            = capacity_provider_strategy.value.weight
      base              = capacity_provider_strategy.value.base
    }
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = var.security_group_ids
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = var.load_balancer == null ? [] : [var.load_balancer]
    content {
      target_group_arn = load_balancer.value.target_group_arn
      container_name   = var.name
      container_port   = var.container_port
    }
  }

  # Publishing services expose `<dns_name>:<port>` to every client in the
  # namespace; client-only services (web, worker) just get the Envoy proxy.
  dynamic "service_connect_configuration" {
    for_each = var.service_connect == null ? [] : [var.service_connect]
    content {
      enabled   = true
      namespace = service_connect_configuration.value.namespace_arn

      dynamic "service" {
        for_each = service_connect_configuration.value.publish ? [service_connect_configuration.value] : []
        content {
          port_name      = var.port_name
          discovery_name = service.value.discovery_name
          client_alias {
            port     = var.container_port
            dns_name = service.value.dns_name
          }
        }
      }
    }
  }

  lifecycle {
    # Autoscaling (worker) and operators own the running count after creation.
    ignore_changes = [desired_count]
  }
}
