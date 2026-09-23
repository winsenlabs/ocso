output "name" {
  description = "Cluster name."
  value       = aws_ecs_cluster.this.name
}

output "arn" {
  description = "Cluster ARN."
  value       = aws_ecs_cluster.this.arn
}

output "service_connect_namespace_arn" {
  description = "Service Connect (Cloud Map HTTP) namespace ARN."
  value       = aws_service_discovery_http_namespace.this.arn
}
