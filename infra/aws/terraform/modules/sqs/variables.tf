variable "name" {
  description = "Queue name prefix."
  type        = string
}

variable "topics" {
  description = "OCSO queue topics (packages/queue/src/contract.ts TOPICS)."
  type        = list(string)
}

variable "max_receive_count" {
  description = "Receives before a message moves to the DLQ."
  type        = number
}

variable "visibility_timeout_seconds" {
  description = "Default visibility timeout."
  type        = number
}

variable "message_retention_seconds" {
  description = "Source queue retention."
  type        = number
}

variable "alarm_actions" {
  description = "SNS topic ARNs notified by the DLQ alarms."
  type        = list(string)
  default     = []
}
