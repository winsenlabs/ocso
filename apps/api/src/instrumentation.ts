/**
 * OpenTelemetry bootstrap, loaded with `node --import ./dist/instrumentation.js`
 * so hooks exist before express/pg load (research/04 §7). No-op unless
 * OTEL_ENABLED=true; exporters read standard OTEL_EXPORTER_OTLP_* env vars.
 */
import { register as registerEsmHooks } from 'import-in-the-middle/register-hooks.mjs';

if (process.env['OTEL_ENABLED'] === 'true') {
  registerEsmHooks();
  const [{ NodeSDK }, { getNodeAutoInstrumentations }, { OTLPTraceExporter }, { OTLPMetricExporter }, { OTLPLogExporter }, metricsSdk, logsSdk, resources, semconv] =
    await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/auto-instrumentations-node'),
      import('@opentelemetry/exporter-trace-otlp-proto'),
      import('@opentelemetry/exporter-metrics-otlp-proto'),
      import('@opentelemetry/exporter-logs-otlp-proto'),
      import('@opentelemetry/sdk-metrics'),
      import('@opentelemetry/sdk-logs'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/semantic-conventions'),
    ]);
  const sdk = new NodeSDK({
    resource: resources.resourceFromAttributes({
      [semconv.ATTR_SERVICE_NAME]: process.env['OTEL_SERVICE_NAME'] ?? 'ocso-api',
      [semconv.ATTR_SERVICE_VERSION]: process.env['APP_VERSION'] ?? 'dev',
    }),
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [new metricsSdk.PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 15_000 })],
    logRecordProcessors: [new logsSdk.BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        '@opentelemetry/instrumentation-router': { enabled: false },
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (r) => (r.url ?? '').startsWith('/health'),
        },
      }),
    ],
  });
  sdk.start();
  (globalThis as { __ocsoOtelSdk?: { shutdown(): Promise<void> } }).__ocsoOtelSdk = sdk;
}
