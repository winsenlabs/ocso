variable "name" {
  description = "Cluster (and Service Connect namespace) name."
  type        = string
}

variable "container_insights" {
  description = "Enable Container Insights (enhanced observability)."
  type        = bool
  default     = true
}
