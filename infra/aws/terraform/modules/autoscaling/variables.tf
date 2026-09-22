variable "name" {
  description = "Name prefix for policies and alarms (the api task role may manage <name>-worker-* alarms)."
  type        = string
}

variable "cluster_name" {
  description = "ECS cluster name."
  type        = string
}

variable "service_name" {
  description = "Worker ECS service name."
  type        = string
}

variable "min_capacity" {
  description = "Initial minimum (warm floor)."
  type        = number
}

variable "max_capacity" {
  description = "Initial maximum."
  type        = number
}

variable "conversations_per_worker" {
  description = "Nominal conversation slots per worker."
  type        = number
}

variable "target_utilization" {
  description = "Target fraction of slots in use (0-1)."
  type        = number
}

variable "scale_out_cooldown" {
  description = "Seconds between scale-out actions."
  type        = number
}

variable "scale_in_cooldown" {
  description = "Seconds before scaling in after the last scale activity."
  type        = number
}

variable "metric_namespace" {
  description = "Namespace of OCSO's scaling metrics."
  type        = string
}

variable "metric_service_dimension" {
  description = "Value of the Service dimension on OCSO scaling metrics."
  type        = string
  default     = "worker"
}

variable "turn_queue_name" {
  description = "SQS queue name for the conversation.turn topic."
  type        = string
}

variable "queue_age_threshold" {
  description = "Seconds of oldest-message age that trigger step scale-out."
  type        = number
}
