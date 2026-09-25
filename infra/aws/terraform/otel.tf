# Optional OpenTelemetry collector sidecar for api and worker
# (research/05 §7). The app always exports OTLP/HTTP to 127.0.0.1:4318; the
# collector signs requests with the task role (SigV4) and forwards:
#   traces  → CloudWatch/X-Ray OTLP endpoint (requires X-Ray Transaction Search
#             to be enabled once per account/region — see docs/guides/deploy/aws.md)
#   metrics → CloudWatch via EMF into /<prefix>/otel-metrics (namespace OCSO/App)
#   logs    → dropped here; application logs already reach CloudWatch as JSON
#             on stdout through awslogs, so exporting them twice is waste.
locals {
  otel_config = {
    for svc in ["api", "worker"] : svc => <<-YAML
      extensions:
        sigv4auth:
          region: ${var.aws_region}
          service: xray
      receivers:
        otlp:
          protocols:
            http:
              endpoint: 127.0.0.1:4318
      processors:
        memory_limiter:
          check_interval: 1s
          limit_mib: 200
        batch: {}
      exporters:
        otlphttp/xray:
          traces_endpoint: https://xray.${var.aws_region}.amazonaws.com/v1/traces
          compression: gzip
          auth:
            authenticator: sigv4auth
        awsemf:
          region: ${var.aws_region}
          namespace: OCSO/App
          log_group_name: /${local.prefix}/otel-metrics
          log_stream_name: ${svc}
        nop: {}
      service:
        extensions: [sigv4auth]
        pipelines:
          traces:
            receivers: [otlp]
            processors: [memory_limiter, batch]
            exporters: [otlphttp/xray]
          metrics:
            receivers: [otlp]
            processors: [memory_limiter, batch]
            exporters: [awsemf]
          logs:
            receivers: [otlp]
            processors: [batch]
            exporters: [nop]
    YAML
  }

  otel_sidecar = {
    for svc, config in local.otel_config : svc => {
      enabled = var.otel_collector.enabled
      image   = var.otel_collector.image
      config  = config
    }
  }
}
