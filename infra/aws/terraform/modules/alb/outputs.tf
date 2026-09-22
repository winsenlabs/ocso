output "security_group_id" {
  description = "ALB security group (allow it into the api and web tasks)."
  value       = aws_security_group.alb.id
}

output "dns_name" {
  description = "ALB DNS name."
  value       = aws_lb.this.dns_name
}

output "zone_id" {
  description = "ALB hosted zone id (for Route 53 alias records)."
  value       = aws_lb.this.zone_id
}

output "arn_suffix" {
  description = "ALB ARN suffix (CloudWatch dimension)."
  value       = aws_lb.this.arn_suffix
}

output "api_target_group_arn" {
  description = "API target group."
  value       = aws_lb_target_group.api.arn
}

output "web_target_group_arn" {
  description = "Web target group."
  value       = aws_lb_target_group.web.arn
}

output "target_group_arn_suffixes" {
  description = "Target group ARN suffixes by service (CloudWatch dimension)."
  value = {
    api = aws_lb_target_group.api.arn_suffix
    web = aws_lb_target_group.web.arn_suffix
  }
}

output "https_listener_arn" {
  description = "HTTPS listener (services depend on it so the TG is attached before tasks register)."
  value       = aws_lb_listener.https.arn
}
