output "bucket_name" {
  description = "Media bucket name."
  value       = aws_s3_bucket.this.bucket
}

output "bucket_arn" {
  description = "Media bucket ARN."
  value       = aws_s3_bucket.this.arn
}

output "kms_key_arn" {
  description = "Bucket CMK ARN (S3_KMS_KEY_ID)."
  value       = aws_kms_key.this.arn
}
