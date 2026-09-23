import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import type { OcsoRequest } from './decorators.js';

const VALID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Accept a caller-supplied correlation id when well-formed, else generate one. */
export function correlationMiddleware(req: OcsoRequest, res: Response, next: NextFunction): void {
  const incoming = req.header('x-correlation-id') ?? req.header('x-request-id');
  const id = incoming && VALID.test(incoming) ? incoming : randomUUID();
  req.correlationId = id;
  res.setHeader('x-correlation-id', id);
  next();
}
