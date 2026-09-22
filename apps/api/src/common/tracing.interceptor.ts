import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { Observable } from 'rxjs';

/**
 * Controller-level spans. The OTel NestJS instrumentation supports Nest < 12
 * only (research/04 §7), so OCSO provides its own thin interceptor.
 */
@Injectable()
export class TracingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const name = `${context.getClass().name}.${context.getHandler().name}`;
    return new Observable((subscriber) => {
      trace.getTracer('ocso-api').startActiveSpan(name, (span) => {
        next.handle().subscribe({
          next: (value) => subscriber.next(value),
          error: (err: unknown) => {
            span.recordException(err as Error);
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.end();
            subscriber.error(err);
          },
          complete: () => {
            span.end();
            subscriber.complete();
          },
        });
      });
    });
  }
}
