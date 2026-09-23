# Worker autoscaling (ADR-023) and baseline alarms.

module "worker_autoscaling" {
  source = "./modules/autoscaling"
  count  = var.deploy_services ? 1 : 0

  name         = local.prefix
  cluster_name = module.ecs_cluster.name
  service_name = module.worker.service_name

  min_capacity             = var.worker_scaling.min_capacity
  max_capacity             = var.worker_scaling.max_capacity
  conversations_per_worker = var.worker_scaling.conversations_per_worker
  target_utilization       = var.worker_scaling.target_utilization
  scale_out_cooldown       = var.worker_scaling.scale_out_cooldown
  scale_in_cooldown        = var.worker_scaling.scale_in_cooldown
  queue_age_threshold      = var.worker_scaling.queue_age_threshold
  metric_namespace         = local.metrics_namespace

  turn_queue_name = module.sqs.queue_names["conversation.turn"]
}

module "observability" {
  source                    = "./modules/observability"
  name                      = local.prefix
  alarm_email_addresses     = var.alarm_email_addresses
  alb_arn_suffix            = module.alb.arn_suffix
  target_group_arn_suffixes = module.alb.target_group_arn_suffixes
  db_instance_identifier    = module.rds.identifier
  turn_queue_name           = module.sqs.queue_names["conversation.turn"]
  otel_enabled              = var.otel_collector.enabled
  log_retention_days        = var.log_retention_days
}
