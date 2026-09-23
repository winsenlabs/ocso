import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import { McpConnectionService, McpOAuthCallbackError, OAuthCallbackInput } from '@ocso/application';
import type { ApiEnv } from '@ocso/config';
import type { Response } from 'express';
import { Public, type OcsoRequest } from '../../common/decorators.js';
import { ENV } from '../../infrastructure/tokens.js';

const REASON = /^[a-z0-9_]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Public OAuth 2.1 redirect target for MCP connections (ADR-020 `/oauth/*`).
 * The only proof of the caller is the single-use `state`, validated by the
 * service. Always answers with a 302 back to the Connections page carrying
 * only a connection id and an outcome code — never tokens, codes or
 * authorization-server text.
 */
@Controller('oauth/mcp')
export class McpOAuthCallbackController {
  private readonly returnBase: string;

  constructor(
    @Inject(McpConnectionService) private readonly connections: McpConnectionService,
    @Inject(ENV) env: ApiEnv,
  ) {
    this.returnBase = `${env.OCSO_PUBLIC_URL.replace(/\/+$/, '')}/connections`;
  }

  @Get('callback')
  @Public()
  async callback(@Query() raw: Record<string, unknown>, @Req() req: OcsoRequest, @Res() res: Response): Promise<void> {
    const target = new URL(this.returnBase);
    target.searchParams.set('tab', 'mcp');
    const parsed = OAuthCallbackInput.safeParse(raw);
    try {
      if (!parsed.success) throw new McpOAuthCallbackError('invalid_request', null);
      const done = await this.connections.completeOAuth(parsed.data, req.correlationId ?? 'oauth-callback');
      target.searchParams.set('connection', done.connectionId);
      target.searchParams.set('oauth', 'ok');
    } catch (err) {
      const failure = err instanceof McpOAuthCallbackError ? err : null;
      if (failure?.connectionId && UUID.test(failure.connectionId)) target.searchParams.set('connection', failure.connectionId);
      target.searchParams.set('oauth', 'error');
      target.searchParams.set('reason', failure && REASON.test(failure.reason) ? failure.reason : 'internal');
    }
    // The inbound URL carried an authorization code: keep it out of caches and Referer headers.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(302, target.href);
  }
}
