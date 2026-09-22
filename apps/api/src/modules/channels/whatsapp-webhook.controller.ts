import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError } from '@ocso/domain';
import { PinoLogger } from 'nestjs-pino';
import { Public, type OcsoRequest } from '../../common/decorators.js';
import { ChannelIngressService, toRawRequest } from './channel-ingress.service.js';

type RawRequest = Request & { rawBody?: Buffer };

/**
 * WhatsApp Cloud API webhook (docs/07 §3). Public route: authenticity is the
 * adapter's X-Hub-Signature-256 check over the raw body. Returns 200 only after
 * every message is persisted, so Meta retries on failure (idempotent ingress).
 */
@Controller('channels/whatsapp')
export class WhatsAppWebhookController {
  constructor(
    @Inject(ChannelIngressService) private readonly channels: ChannelIngressService,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  @Get(':publicKey/webhook')
  @Public()
  async verify(@Param('publicKey') publicKey: string, @Query() query: Record<string, unknown>, @Req() req: Request, @Res() res: Response): Promise<void> {
    const { adapter, config } = await this.channels.resolve(publicKey, 'WHATSAPP');
    const result = adapter.verifyRequest(toRawRequest('GET', req.headers, query, undefined), config);
    if (result.kind === 'challenge') {
      res.status(200).type('text/plain').send(result.body);
      return;
    }
    res.status(result.kind === 'rejected' ? result.status : 400).json({ error: 'verification failed' });
  }

  @Post(':publicKey/webhook')
  @Public()
  @HttpCode(200)
  async receive(@Param('publicKey') publicKey: string, @Req() req: RawRequest & OcsoRequest): Promise<{ ok: true; accepted: number; duplicates: number }> {
    const { adapter, config } = await this.channels.resolve(publicKey, 'WHATSAPP');
    const raw = toRawRequest('POST', req.headers, {}, req.rawBody);
    const verified = adapter.verifyRequest(raw, config);
    if (verified.kind === 'rejected') {
      throw new DomainError(verified.status === 401 ? 'authentication' : 'authorization', 'webhook_signature_invalid', 'Webhook signature verification failed');
    }
    const envelope = adapter.parseInbound(raw, config);
    const summary = await this.channels.process(config.id, envelope, req.correlationId ?? 'whatsapp');
    this.logger.info({ channelId: config.id, accepted: summary.accepted, duplicates: summary.duplicates, statuses: summary.statuses, ignored: envelope.ignored }, 'whatsapp webhook');
    return { ok: true, accepted: summary.accepted, duplicates: summary.duplicates };
  }
}
