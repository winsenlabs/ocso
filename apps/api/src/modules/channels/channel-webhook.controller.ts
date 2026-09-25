import { Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ApiEnv } from '@ocso/config';
import { DomainError } from '@ocso/domain';
import { PinoLogger } from 'nestjs-pino';
import { Public, type OcsoRequest } from '../../common/decorators.js';
import { ENV } from '../../infrastructure/tokens.js';
import { ChannelIngressService, toRawRequest } from './channel-ingress.service.js';

type RawRequest = Request & OcsoRequest & { rawBody?: Buffer };

/**
 * Provider webhooks for every inbound-webhook channel kind (docs/archive/specs/07 §3):
 * `/channels/<segment>/<publicKey>/webhook`, where the segment comes from the
 * adapter's descriptor (`whatsapp` = Meta Cloud API, `twilio-whatsapp` = Twilio).
 * Public routes: authenticity is the adapter's signature check (Meta HMAC over
 * the raw body; Twilio HMAC over the public URL + form params). Answers only
 * after every message is persisted, so the provider retries on failure.
 */
@Controller('channels')
export class ChannelWebhookController {
  private readonly publicOrigin: string;

  constructor(
    @Inject(ChannelIngressService) private readonly channels: ChannelIngressService,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
    @Inject(ENV) env: ApiEnv,
  ) {
    this.publicOrigin = new URL(env.OCSO_PUBLIC_URL).origin;
  }

  /** Subscription handshakes (Meta's verify-token challenge); kinds without one reject GET. */
  @Get(':segment/:publicKey/webhook')
  @Public()
  async verify(
    @Param('segment') segment: string,
    @Param('publicKey') publicKey: string,
    @Query() query: Record<string, unknown>,
    @Req() req: RawRequest,
    @Res() res: Response,
  ): Promise<void> {
    const { adapter, config } = await this.channels.resolveWebhook(segment, publicKey);
    const result = await adapter.verifyRequest(toRawRequest('GET', req.headers, query, undefined, this.publicUrl(req)), config);
    if (result.kind === 'challenge') {
      res.status(200).type('text/plain').send(result.body);
      return;
    }
    res.status(result.kind === 'rejected' ? result.status : 400).json({ error: 'verification failed' });
  }

  @Post(':segment/:publicKey/webhook')
  @Public()
  async receive(@Param('segment') segment: string, @Param('publicKey') publicKey: string, @Req() req: RawRequest, @Res() res: Response): Promise<void> {
    const { adapter, config } = await this.channels.resolveWebhook(segment, publicKey);
    const raw = toRawRequest('POST', req.headers, {}, req.rawBody, this.publicUrl(req));
    const verified = await adapter.verifyRequest(raw, config);
    if (verified.kind === 'rejected') {
      throw new DomainError(verified.status === 401 ? 'authentication' : 'authorization', 'webhook_signature_invalid', 'Webhook signature verification failed');
    }
    // A verified handshake posted to the webhook (e.g. Slack's url_verification): answer it, store nothing.
    if (verified.kind === 'challenge') {
      res.status(200).type('text/plain').send(verified.body);
      return;
    }
    const envelope = adapter.parseInbound(raw, config);
    const summary = await this.channels.process(config.id, envelope, req.correlationId ?? segment);
    const counts = { channelId: config.id, kind: config.kind, accepted: summary.accepted, duplicates: summary.duplicates, rejected: summary.rejected, statuses: summary.statuses, ignored: envelope.ignored };
    const rejections = summary.results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    // A rejected customer message is lost to the customer: say why, loudly.
    if (rejections.length) this.logger.warn({ ...counts, reasons: [...new Set(rejections)] }, 'channel webhook: customer messages rejected');
    else this.logger.info(counts, 'channel webhook');
    const ack = adapter.webhookAcknowledgement?.();
    if (ack) {
      res.status(ack.status).type(ack.contentType).send(ack.body);
      return;
    }
    res.status(200).json({ ok: true, accepted: summary.accepted, duplicates: summary.duplicates });
  }

  /** The URL as the provider called it: public origin (not the proxied host) + path and query exactly as received. */
  private publicUrl(req: Request): string {
    return `${this.publicOrigin}${req.originalUrl}`;
  }
}
