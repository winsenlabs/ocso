import { metrics, trace, SpanStatusCode, type Attributes, type Span } from '@opentelemetry/api';

/**
 * OCSO metric instruments (docs/archive/specs/11 §5). Attributes must stay low-cardinality:
 * provider, profile, outcome, topic — never conversation or user ids.
 */
const meter = () => metrics.getMeter('ocso');

let instruments: ReturnType<typeof create> | null = null;

function create() {
  const m = meter();
  return {
    turnDuration: m.createHistogram('ocso.agent.turn.duration', {
      unit: 's',
      advice: { explicitBucketBoundaries: [0.25, 0.5, 1, 2, 4, 8, 15, 30, 60, 120] },
    }),
    ttft: m.createHistogram('ocso.model.ttft', { unit: 's', advice: { explicitBucketBoundaries: [0.1, 0.25, 0.5, 1, 2, 4, 8] } }),
    modelRequests: m.createCounter('ocso.model.requests'),
    tokens: m.createCounter('ocso.model.tokens'),
    toolCalls: m.createCounter('ocso.tool.calls'),
    toolDuration: m.createHistogram('ocso.tool.duration', { unit: 's' }),
    queueJobs: m.createCounter('ocso.queue.jobs'),
    activeLeases: m.createUpDownCounter('ocso.worker.active_leases'),
    alertsOpened: m.createCounter('ocso.alerts.opened'),
  };
}

export function ocsoMetrics() {
  instruments ??= create();
  return instruments;
}

const tracer = () => trace.getTracer('ocso');

/** Run `fn` inside an active span; records exceptions and status. */
export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).name });
      throw err;
    } finally {
      span.end();
    }
  });
}

export function currentTraceId(): string | null {
  const ctx = trace.getActiveSpan()?.spanContext();
  return ctx && ctx.traceId !== '00000000000000000000000000000000' ? ctx.traceId : null;
}
