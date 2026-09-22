import type { LoggerService } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { toNodeHandler } from 'better-auth/node';
import type { AuthServer } from '@ocso/application/auth-server';
import type { Request, Response } from 'express';
import { AUTH } from '../infrastructure/tokens.js';
import { correlationMiddleware } from './correlation.js';
import type { OcsoRequest } from './decorators.js';

/** Where Better Auth is served; browsers reach it on the public origin through the web app's proxy. */
export const AUTH_BASE_PATH = '/api/auth';

/**
 * Mounts Better Auth's handler at /api/auth/* on the underlying Express app,
 * ahead of Nest's body parsers and routes (Better Auth parses its own JSON,
 * form-encoded SAML posts included). Its endpoints are not Nest controllers:
 * which of them answer over HTTP is decided by OCSO's policy plugin allowlist
 * (HTTP_AUTH_ENDPOINTS), pinned by test/unit/auth-surface.test.ts.
 */
export function mountAuthHandler(app: NestExpressApplication, logger: LoggerService): void {
  const auth = app.get<AuthServer>(AUTH);
  const handle = toNodeHandler(auth.handler);
  app.getHttpAdapter()
    .getInstance()
    .all(`${AUTH_BASE_PATH}/*splat`, (req: Request, res: Response) => {
      correlationMiddleware(req as OcsoRequest, res, () => {
        // Better Auth only sees headers: carry the correlation id into its audit records.
        req.headers['x-correlation-id'] = (req as OcsoRequest).correlationId;
        handle(req, res).catch((err: unknown) => {
          logger.error(`auth request failed: ${err instanceof Error ? err.message : 'unknown error'}`);
          if (res.headersSent) return;
          res.status(500).json({ code: 'INTERNAL_SERVER_ERROR', message: 'Something went wrong' });
        });
      });
    });
}
