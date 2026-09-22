output "queue_urls" {
  description = "Queue URL by topic."
  value       = { for t, q in aws_sqs_queue.this : t => q.id }
}

output "queue_names" {
  description = "Queue name by topic."
  value       = { for t, q in aws_sqs_queue.this : t => q.name }
}

output "queue_arns" {
  description = "Source queue ARNs."
  value       = [for q in aws_sqs_queue.this : q.arn]
}

output "dlq_arns" {
  description = "Dead-letter queue ARNs."
  value       = [for q in aws_sqs_queue.dlq : q.arn]
}

output "dlq_urls" {
  description = "DLQ URL by topic."
  value       = { for t, q in aws_sqs_queue.dlq : t => q.id }
}

output "sqs_queue_urls_env" {
  description = "Value for SQS_QUEUE_URLS (topic=url pairs, comma separated)."
  value       = join(",", [for t in sort(keys(aws_sqs_queue.this)) : "${t}=${aws_sqs_queue.this[t].id}"])
}
