# ECS cluster with Fargate + Fargate Spot and a Service Connect namespace.
# Service Connect gives the API the stable in-cluster name `api:4000`, which is
# the same address the web image uses in Compose (rewrites are baked at build).
resource "aws_service_discovery_http_namespace" "this" {
  name        = var.name
  description = "OCSO Service Connect namespace"
}

resource "aws_ecs_cluster" "this" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = var.container_insights ? "enhanced" : "disabled"
  }

  service_connect_defaults {
    namespace = aws_service_discovery_http_namespace.this.arn
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 0
  }
}
