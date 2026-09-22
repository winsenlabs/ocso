/// <reference path="./types/import-in-the-middle.d.ts" />
/**
 * OpenTelemetry bootstrap shared by api and worker (research/04 §7). Loaded via
 * each app's tiny `instrumentation.ts` with `node --import`, before express/pg
 * load. No-op unless OTEL_ENABLED=true; exporters read OTEL_EXPORTER_OTLP_*.
 */
import { register as registerEsmHooks } from 'import-in-the-middle/register-hooks.mjs';

export interface OtelHandle {
  shutdown(): Promise<void>;
}

export async function startOtel(defaultServiceName: string): Promise<OtelHandle | null> {
  if (process.env['OTEL_ENABLED'] !== 'true') return null;
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
      [semconv.ATTR_SERVICE_NAME]: process.env['OTEL_SERVICE_NAME'] ?? defaultServiceName,
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
        '@opentelemetry/instrumentation-http': { ignoreIncomingRequestHook: (r) => (r.url ?? '').startsWith('/health') },
      }),
    ],
  });
  sdk.start();
  const handle = { shutdown: () => sdk.shutdown() };
  (globalThis as { __ocsoOtelSdk?: OtelHandle }).__ocsoOtelSdk = handle;
  return handle;
}

/** Flush telemetry during graceful shutdown (call from Nest onApplicationShutdown). */
export async function shutdownOtel(): Promise<void> {
  await (globalThis as { __ocsoOtelSdk?: OtelHandle }).__ocsoOtelSdk?.shutdown().catch(() => {});
}
