output "public_url" {
  description = "OCSO_PUBLIC_URL."
  value       = local.public_url
}

output "alb_dns_name" {
  description = "ALB DNS name (CNAME/alias public_hostname to it if route53_zone_id is not set)."
  value       = module.alb.dns_name
}

output "ecr_repository_urls" {
  description = "Push targets per Dockerfile target."
  value       = module.ecr.repository_urls
}

output "cluster_name" {
  description = "ECS cluster."
  value       = module.ecs_cluster.name
}

output "service_names" {
  description = "ECS service names (null until deploy_services = true)."
  value = {
    api    = module.api.service_name
    web    = module.web.service_name
    worker = module.worker.service_name
  }
}

output "migrate_task_definition_arn" {
  description = "Task definition to run before every deploy."
  value       = module.migrate.task_definition_arn
}

output "migrate_network_configuration" {
  description = "--network-configuration value for `aws ecs run-task` (private subnets, migrate SG, no public IP)."
  value = jsonencode({
    awsvpcConfiguration = {
      subnets        = module.network.private_subnet_ids
      securityGroups = [aws_security_group.task["migrate"].id]
      assignPublicIp = "DISABLED"
    }
  })
}

output "migrate_log_group" {
  description = "Migration logs."
  value       = module.migrate.log_group_name
}

output "metrics_namespace" {
  description = "OCSO_METRICS_NAMESPACE (worker scaling metrics)."
  value       = local.metrics_namespace
}

output "worker_scaling" {
  description = "Names the worker's ECS deployment adapter updates at runtime (null until deploy_services = true)."
  value = var.deploy_services ? {
    resource_id          = module.worker_autoscaling[0].resource_id
    policy_names         = module.worker_autoscaling[0].policy_names
    queue_age_alarm_name = module.worker_autoscaling[0].queue_age_alarm_name
    alarm_name_prefix    = local.scaling_alarm_prefix
  } : null
}

output "queue_urls" {
  description = "SQS queue URL by topic."
  value       = module.sqs.queue_urls
}

output "dlq_urls" {
  description = "Dead-letter queue URL by topic."
  value       = module.sqs.dlq_urls
}

output "media_bucket" {
  description = "Media bucket name."
  value       = module.s3.bucket_name
}

output "bootstrap_secret_arn" {
  description = "Bootstrap secret (DATABASE_URL, OCSO_INTERNAL_SIGNING_KEY, OCSO_SETUP_TOKEN)."
  value       = module.secrets.bootstrap_secret_arn
}

output "runtime_secrets_prefix" {
  description = "SECRETS_NAME_PREFIX used by the application."
  value       = module.secrets.runtime_prefix
}

output "db_endpoint" {
  description = "RDS host:port (private)."
  value       = "${module.rds.address}:${module.rds.port}"
}

output "nat_public_ips" {
  description = "Egress IPs to allowlist on external MCP/tool servers."
  value       = module.network.nat_public_ips
}

output "alarm_topic_arn" {
  description = "SNS topic for infrastructure alarms."
  value       = module.observability.alarm_topic_arn
}

output "log_groups" {
  description = "Container log groups."
  value = {
    api     = module.api.log_group_name
    web     = module.web.log_group_name
    worker  = module.worker.log_group_name
    migrate = module.migrate.log_group_name
  }
}
