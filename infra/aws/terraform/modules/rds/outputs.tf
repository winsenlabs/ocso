output "address" {
  description = "DB host name."
  value       = aws_db_instance.this.address
}

output "port" {
  description = "DB port."
  value       = aws_db_instance.this.port
}

output "identifier" {
  description = "DB instance identifier (CloudWatch dimension DBInstanceIdentifier)."
  value       = aws_db_instance.this.identifier
}

output "db_name" {
  description = "Database name."
  value       = aws_db_instance.this.db_name
}

output "username" {
  description = "Application user."
  value       = aws_db_instance.this.username
}

output "security_group_id" {
  description = "DB security group."
  value       = aws_security_group.this.id
}
