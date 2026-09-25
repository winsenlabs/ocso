# Images, cluster, load balancer and the three OCSO services (web, api,
# worker) plus the one-off migration task. One image layout per target, same
# images as Docker Compose (build rule §17).

module "ecr" {
  source      = "./modules/ecr"
  name_prefix = coalesce(var.ecr_name_prefix, "${var.name}-")
  keep_images = var.ecr_keep_images
}

module "ecs_cluster" {
  source             = "./modules/ecs-cluster"
  name               = local.prefix
  container_insights = var.enable_container_insights
}

module "alb" {
  source               = "./modules/alb"
  name                 = local.prefix
  vpc_id               = module.network.vpc_id
  vpc_cidr_block       = module.network.vpc_cidr_block
  public_subnet_ids    = module.network.public_subnet_ids
  certificate_arn      = var.acm_certificate_arn
  ingress_cidrs        = var.alb_ingress_cidrs
  idle_timeout_seconds = var.alb_idle_timeout_seconds
  deletion_protection  = var.alb_deletion_protection
  access_logs_bucket   = var.alb_access_logs_bucket
}

resource "aws_route53_record" "public" {
  count   = var.route53_zone_id == null ? 0 : 1
  zone_id = var.route53_zone_id
  name    = var.public_hostname
  type    = "A"

  alias {
    name                   = module.alb.dns_name
    zone_id                = module.alb.zone_id
    evaluate_target_health = true
  }
}

# ---------------------------------------------------------------------------
# API: control plane + public ingress (/channels, /public, /oauth,
# /.well-known, /blobs). Published in Service Connect as api:4000.
# ---------------------------------------------------------------------------
module "api" {
  source           = "./modules/service"
  name             = local.services.api
  family           = "${local.prefix}-api"
  region           = var.aws_region
  cluster_arn      = module.ecs_cluster.arn
  image            = local.images["api"]
  cpu              = var.api.cpu
  memory           = var.api.memory
  cpu_architecture = var.cpu_architecture

  # One hop: the ALB appends the client address to X-Forwarded-For (per-address limits on /public/webchat).
  environment = merge(local.app_env, { PORT = "4000", TRUST_PROXY = "1" })
  secrets     = local.api_secrets

  container_port = 4000
  health_check   = { port = 4000, path = "/health/ready", start_period = 30 }

  execution_role_arn = module.iam.execution_role_arns["app"]
  task_role_arn      = module.iam.task_role_arns["api"]
  subnet_ids         = module.network.private_subnet_ids
  security_group_ids = [aws_security_group.task["api"].id]

  create_service = var.deploy_services
  desired_count  = var.api.desired_count
  load_balancer  = { target_group_arn = module.alb.api_target_group_arn }
  service_connect = {
    namespace_arn  = module.ecs_cluster.service_connect_namespace_arn
    publish        = true
    discovery_name = "api"
    dns_name       = "api"
  }

  enable_execute_command = var.enable_execute_command
  log_retention_days     = var.log_retention_days
  otel_collector         = local.otel_sidecar["api"]

  # The target group must be attached to a listener before ECS registers tasks.
  depends_on = [module.alb]
}

# ---------------------------------------------------------------------------
# Web: Next.js BFF. Browsers only talk to it; it calls the API over Service
# Connect at http://api:4000 (the same URL baked into the image's rewrites).
# ---------------------------------------------------------------------------
module "web" {
  source           = "./modules/service"
  name             = local.services.web
  family           = "${local.prefix}-web"
  region           = var.aws_region
  cluster_arn      = module.ecs_cluster.arn
  image            = local.images["web"]
  cpu              = var.web.cpu
  memory           = var.web.memory
  cpu_architecture = var.cpu_architecture

  environment = {
    NODE_ENV                = "production"
    API_URL                 = "http://api:4000"
    HOSTNAME                = "0.0.0.0"
    PORT                    = "3000"
    NEXT_TELEMETRY_DISABLED = "1"
    # The ALB appends the client address to X-Forwarded-For (per-address sign-in throttling, audit).
    OCSO_TRUSTED_PROXY_HOPS = "1"
    # Allowed origin for cookie-bearing requests and the base of absolute links, as in Compose.
    OCSO_PUBLIC_URL = local.public_url
  }

  container_port = 3000
  health_check   = { port = 3000, path = "/login", start_period = 20 }

  execution_role_arn = module.iam.execution_role_arns["web"]
  task_role_arn      = module.iam.task_role_arns["web"]
  subnet_ids         = module.network.private_subnet_ids
  security_group_ids = [aws_security_group.task["web"].id]

  create_service = var.deploy_services
  desired_count  = var.web.desired_count
  load_balancer  = { target_group_arn = module.alb.web_target_group_arn }
  service_connect = {
    namespace_arn = module.ecs_cluster.service_connect_namespace_arn
    publish       = false # client only
  }

  enable_execute_command = var.enable_execute_command
  log_retention_days     = var.log_retention_days

  depends_on = [module.alb]
}

# ---------------------------------------------------------------------------
# Worker: agent turns, deliveries, schedulers. No inbound traffic; count is
# owned by autoscaling. Long stop timeout lets a running turn finish or
# checkpoint and release its lease; maximum_percent 200 lets new tasks start
# beside scale-in-protected ones during deploys.
# ---------------------------------------------------------------------------
module "worker" {
  source           = "./modules/service"
  name             = local.services.worker
  family           = "${local.prefix}-worker"
  region           = var.aws_region
  cluster_arn      = module.ecs_cluster.arn
  image            = local.images["worker"]
  cpu              = var.worker.cpu
  memory           = var.worker.memory
  cpu_architecture = var.cpu_architecture

  # The worker leader runs OCSO's ECS deployment adapter (ADR-023): it
  # publishes scaling metrics and applies Tech Admin scaling settings.
  environment = merge(local.app_env, {
    HEALTH_PORT            = "4100"
    OCSO_METRICS_NAMESPACE = local.metrics_namespace
  })
  secrets = local.worker_secrets

  health_check = { port = 4100, path = "/health/ready", start_period = 30 }
  stop_timeout = 120

  execution_role_arn = module.iam.execution_role_arns["app"]
  task_role_arn      = module.iam.task_role_arns["worker"]
  subnet_ids         = module.network.private_subnet_ids
  security_group_ids = [aws_security_group.task["worker"].id]

  create_service             = var.deploy_services
  desired_count              = var.worker_scaling.min_capacity
  capacity_provider_strategy = local.worker_capacity
  deployment_maximum_percent = 200

  enable_execute_command = var.enable_execute_command
  log_retention_days     = var.log_retention_days
  otel_collector         = local.otel_sidecar["worker"]
}

module "migrate" {
  source           = "./modules/migrate-task"
  family           = "${local.prefix}-migrate"
  region           = var.aws_region
  image            = local.images["migrate"]
  cpu              = var.migrate.cpu
  memory           = var.migrate.memory
  cpu_architecture = var.cpu_architecture

  environment = merge(local.database_env, { NODE_ENV = "production" })
  secrets     = local.migrate_secrets

  execution_role_arn = module.iam.execution_role_arns["app"]
  task_role_arn      = module.iam.task_role_arns["migrate"]
  log_retention_days = var.log_retention_days
}
