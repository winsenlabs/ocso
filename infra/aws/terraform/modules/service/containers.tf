# Container definitions for one OCSO service (web, api or worker) plus the
# optional OpenTelemetry collector sidecar (research/05 §7).
locals {
  log_configuration = {
    logDriver = "awslogs"
    options = {
      "awslogs-group"         = aws_cloudwatch_log_group.this.name
      "awslogs-region"        = var.region
      "awslogs-stream-prefix" = var.name
      # Never block the app on CloudWatch back-pressure; drop instead.
      "mode"            = "non-blocking"
      "max-buffer-size" = "25m"
    }
  }

  # node:26-slim has no curl/wget, so probe with Node's fetch.
  health_check = {
    command = [
      "CMD", "node", "-e",
      "fetch('http://127.0.0.1:${var.health_check.port}${var.health_check.path}').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))",
    ]
    interval    = 15
    timeout     = 5
    retries     = 3
    startPeriod = var.health_check.start_period
  }

  port_mappings = var.container_port == null ? [] : [{
    name          = var.port_name
    containerPort = var.container_port
    protocol      = "tcp"
    appProtocol   = "http"
  }]

  app_container = merge(
    {
      name                   = var.name
      image                  = var.image
      essential              = true
      environment            = [for k, v in var.environment : { name = k, value = v }]
      secrets                = [for k, v in var.secrets : { name = k, valueFrom = v }]
      portMappings           = local.port_mappings
      healthCheck            = local.health_check
      logConfiguration       = local.log_configuration
      stopTimeout            = var.stop_timeout
      linuxParameters        = { initProcessEnabled = true } # reap zombies, forward SIGTERM
      readonlyRootFilesystem = false                         # Next.js writes .next/cache at runtime
    },
    var.command == null ? {} : { command = var.command },
    var.otel_collector.enabled ? { dependsOn = [{ containerName = "otel-collector", condition = "START" }] } : {},
  )

  # The contrib collector reads its whole config from an env var
  # (`--config=env:…`), so no config file or extra image is needed.
  collector_container = {
    name             = "otel-collector"
    image            = var.otel_collector.image
    essential        = false # telemetry loss must not take the service down
    command          = ["--config=env:OTELCOL_CONFIG"]
    environment      = [{ name = "OTELCOL_CONFIG", value = var.otel_collector.config }]
    logConfiguration = merge(local.log_configuration, { options = merge(local.log_configuration.options, { "awslogs-stream-prefix" = "otel" }) })
  }

  # slice() avoids a conditional between tuples of different lengths.
  container_definitions = concat([local.app_container], slice([local.collector_container], 0, var.otel_collector.enabled ? 1 : 0))
}
