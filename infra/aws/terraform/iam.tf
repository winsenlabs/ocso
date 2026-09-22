module "iam" {
  source              = "./modules/iam"
  name                = local.prefix
  cluster_name        = local.prefix
  worker_service_name = local.services.worker

  queue_arns        = module.sqs.queue_arns
  dlq_arns          = module.sqs.dlq_arns
  media_bucket_arn  = module.s3.bucket_arn
  media_kms_key_arn = module.s3.kms_key_arn

  execution_secret_policy_json = module.secrets.execution_read_policy_json
  runtime_secrets_policy_json  = module.secrets.runtime_manage_policy_json
  metric_namespace             = local.metrics_namespace
  alarm_name_prefix            = local.scaling_alarm_prefix
  worker_scalable_target_arn   = var.deploy_services ? module.worker_autoscaling[0].scalable_target_arn : null

  otel_enabled               = var.otel_collector.enabled
  otel_metrics_log_group_arn = module.observability.otel_metrics_log_group_arn
  enable_execute_command     = var.enable_execute_command
}
