output "vpc_id" {
  description = "VPC id."
  value       = aws_vpc.this.id
}

output "vpc_cidr_block" {
  description = "VPC CIDR."
  value       = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  description = "Public subnet ids (ALB, NAT)."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Private subnet ids (ECS tasks, RDS)."
  value       = aws_subnet.private[*].id
}

output "nat_public_ips" {
  description = "Egress IPs of the NAT gateways (give these to MCP/tool servers that allowlist callers)."
  value       = aws_eip.nat[*].public_ip
}
