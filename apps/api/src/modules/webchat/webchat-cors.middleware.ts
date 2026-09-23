import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { CORS_HEADERS, corsOriginAllowed } from './webchat-access.js';
import { WebChatIdentityService } from './webchat-identity.service.js';

const PATH = /^\/public\/webchat\/([^/?#]+)\/([^/?#]+)/;
/** Server-to-server only: never CORS-enabled, so a browser can neither preflight nor read it. */
const SERVER_ONLY = new Set(['session-pass']);

/**
 * CORS for the public web chat API (SPEC §C.3): a preflight or response
 * echoes `Access-Control-Allow-Origin` only for a site the channel allows
 * (an empty allowlist = any site), always with `Vary: Origin`; no
 * credentials (bearer tokens only). Unknown channels get no CORS headers.
 * The handlers still enforce the origin rules themselves.
 */
@Injectable()
export class WebChatCorsMiddleware implements NestMiddleware {
  constructor(@Inject(WebChatIdentityService) private readonly identity: WebChatIdentityService) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const match = PATH.exec(req.originalUrl);
    const origin = req.headers.origin;
    if (!match) return next();
    const [, publicKey, action] = match as unknown as [string, string, string];
    if (SERVER_ONLY.has(action)) {
      if (req.method === 'OPTIONS') res.status(403).end();
      else next();
      return;
    }
    // Always, even without an Origin: a shared cache must never serve an origin-less response to a browser (or back).
    res.vary('Origin');
    if (origin && (await this.allowed(req, publicKey, origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      for (const [name, value] of Object.entries(CORS_HEADERS)) res.setHeader(name, value);
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  }

  private async allowed(req: Request, publicKey: string, origin: string): Promise<boolean> {
    try {
      const ctx = await this.identity.channelForRequest(req, decodeURIComponent(publicKey));
      return corsOriginAllowed(origin, ctx.embed.widgetConfig(ctx.config));
    } catch {
      return false;
    }
  }
}
