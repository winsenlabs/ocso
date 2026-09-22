import { Catch, HttpException, Inject, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { isDomainError, type ErrorCategory } from '@ocso/domain';
import { PinoLogger } from 'nestjs-pino';
import type { Response } from 'express';
import type { OcsoRequest } from './decorators.js';

const STATUS: Readonly<Record<ErrorCategory, number>> = {
  validation: 400,
  authentication: 401,
  authorization: 403,
  not_found: 404,
  conflict: 409,
  policy_denied: 403,
  tool_rejected: 422,
  provider_rate_limited: 429,
  provider_unavailable: 502,
  tool_unavailable: 502,
  capacity: 503,
  timeout: 504,
  internal: 500,
};

export interface ErrorBody {
  error: {
    category: ErrorCategory;
    code: string;
    message: string;
    details?: Readonly<Record<string, unknown>> | undefined;
    correlationId: string | undefined;
  };
}

/**
 * Normalizes every error to the docs/14 §5 categories. Unknown errors become
 * `internal` with a generic message; raw exception text never reaches clients.
 */
@Catch()
export class OcsoExceptionFilter implements ExceptionFilter {
  constructor(@Inject(PinoLogger) private readonly logger: PinoLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<OcsoRequest>();
    const body = this.toBody(exception, req.correlationId);
    const status = exception instanceof HttpException && !isDomainError(exception) ? exception.getStatus() : STATUS[body.error.category];
    if (status >= 500) this.logger.error({ err: exception, correlationId: req.correlationId }, 'request failed');
    if (res.headersSent) return;
    res.status(status).json(body);
  }

  private toBody(exception: unknown, correlationId: string | undefined): ErrorBody {
    if (isDomainError(exception)) {
      return {
        error: { category: exception.category, code: exception.code, message: exception.message, details: exception.details, correlationId },
      };
    }
    if (exception instanceof Error && exception.name === 'ZodError' && 'issues' in exception) {
      const issues = (exception as Error & { issues: Array<{ path: PropertyKey[]; message: string }> }).issues;
      return {
        error: {
          category: 'validation',
          code: 'invalid_request',
          message: issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; '),
          correlationId,
        },
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const messages = typeof response === 'object' && response && 'message' in response ? (response as { message: unknown }).message : exception.message;
      const category: ErrorCategory = status === 400 ? 'validation' : status === 404 ? 'not_found' : status === 401 ? 'authentication' : status === 403 ? 'authorization' : 'internal';
      return {
        error: {
          category,
          code: status === 400 ? 'invalid_request' : `http_${status}`,
          message: Array.isArray(messages) ? messages.join('; ') : String(messages),
          correlationId,
        },
      };
    }
    return { error: { category: 'internal', code: 'internal_error', message: 'Something went wrong', correlationId } };
  }
}
