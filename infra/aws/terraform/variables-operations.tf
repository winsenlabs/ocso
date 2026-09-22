# Scaling, data stores and observability inputs.

# ---------------------------------------------------------------------------
# Worker autoscaling (ADR-023). OCSO's ECS deployment adapter (worker leader)
# owns min/max, policies and thresholds at runtime; these are initial values.
# ---------------------------------------------------------------------------
variable "worker_scaling" {
  description = "Initial worker autoscaling settings."
  type = object({
    min_capacity             = number
    max_capacity             = number
    conversations_per_worker = number
    target_utilization       = number
    scale_out_cooldown       = number
    scale_in_cooldown        = number
    queue_age_threshold      = number # seconds; step scaling starts here
    # CloudWatch namespace for OCSO scaling metrics (OCSO_METRICS_NAMESPACE).
    # Default OCSO/<name>-<environment>, so environments sharing an account
    # never mix metrics and PutMetricData can be scoped per deployment.
    metric_namespace = optional(string)
  })
  default = {
    min_capacity             = 2
    max_capacity             = 10
    conversations_per_worker = 10
    target_utilization       = 0.75
    scale_out_cooldown       = 60
    scale_in_cooldown        = 180
    queue_age_threshold      = 30
  }
}

# ---------------------------------------------------------------------------
# Data stores
# ---------------------------------------------------------------------------
variable "db" {
  description = "RDS PostgreSQL settings."
  type = object({
    engine_version          = string
    instance_class          = string
    allocated_storage       = number
    max_allocated_storage   = number
    multi_az                = bool
    backup_retention_days   = number
    deletion_protection     = bool
    performance_insights    = bool
    apply_immediately       = bool
    skip_final_snapshot     = bool
    backup_window           = string
    maintenance_window      = string
    parameter_group_family  = string
    ca_cert_identifier      = string
    auto_minor_upgrade      = bool
    monitoring_interval_sec = number
  })
  default = {
    engine_version          = "18"
    instance_class          = "db.t4g.medium"
    allocated_storage       = 50
    max_allocated_storage   = 500
    multi_az                = true
    backup_retention_days   = 14
    deletion_protection     = true
    performance_insights    = true
    apply_immediately       = false
    skip_final_snapshot     = false
    backup_window           = "20:30-21:30" # 02:00-03:00 IST
    maintenance_window      = "sun:21:30-sun:22:30"
    parameter_group_family  = "postgres18"
    ca_cert_identifier      = "rds-ca-rsa2048-g1"
    auto_minor_upgrade      = true
    monitoring_interval_sec = 0
  }
}

variable "bootstrap_secret_version" {
  description = "Bump to regenerate the database password, internal signing key and setup token together (write-only rotation). Then force a new deployment."
  type        = number
  default     = 1
}

variable "sqs" {
  description = "SQS settings for the OCSO topic queues."
  type = object({
    max_receive_count          = number
    visibility_timeout_seconds = number
    message_retention_seconds  = number
  })
  default = {
    max_receive_count          = 5
    visibility_timeout_seconds = 120
    message_retention_seconds  = 345600 # 4 days; DLQs keep 14 days
  }
}

variable "queue_topics" {
  description = "Queue topics; must match TOPICS in packages/queue/src/contract.ts."
  type        = list(string)
  default = [
    "conversation.turn",
    "channel.deliver",
    "media.fetch",
    "conversation.summarize",
    "conversation.insights",
    "copilot.suggest",
    "tool.execute_confirmed",
    "alert.deliver",
    "webhook.deliver",
    "evaluation.run",
  ]
}

variable "media" {
  description = "Media bucket settings."
  type = object({
    temp_expiry_days                = number
    noncurrent_expiry_days          = number
    force_destroy                   = bool
    extra_cors_allowed_origins      = list(string)
    abort_incomplete_multipart_days = number
  })
  default = {
    temp_expiry_days                = 2
    noncurrent_expiry_days          = 30
    force_destroy                   = false
    extra_cors_allowed_origins      = []
    abort_incomplete_multipart_days = 7
  }
}

# ---------------------------------------------------------------------------
# Observability
# ---------------------------------------------------------------------------
variable "enable_container_insights" {
  description = "ECS Container Insights (enhanced) on the cluster. Not required for OCSO scaling signals."
  type        = bool
  default     = true
}

variable "otel_collector" {
  description = "Optional OpenTelemetry collector sidecar (research/05 §7): OTLP from the app → X-Ray (traces) and CloudWatch EMF (metrics)."
  type = object({
    enabled             = bool
    image               = string
    traces_sample_ratio = number
  })
  default = {
    enabled             = false
    image               = "otel/opentelemetry-collector-contrib:0.161.0"
    traces_sample_ratio = 0.05
  }
}

variable "alarm_email_addresses" {
  description = "Email addresses subscribed to the alarm SNS topic (confirm the subscription emails)."
  type        = list(string)
  default     = []
}
