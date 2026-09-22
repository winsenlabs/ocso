import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Sse, SseSignal, type MessageEvent } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable, fromEvent, interval, map, merge, takeUntil } from 'rxjs';
import {
  attachmentKeyPrefix,
  isVisitorToken,
  issueVisitorToken,
  mediaKindForMime,
  newVisitorId,
  originAllowed,
  resolveWebChatConfig,
  verifyHostJwt,
  verifyVisitorToken,
} from '@ocso/channels';
import { checkMedia, extensionFor, type BlobStore } from '@ocso/blob';
import type { ApiEnv } from '@ocso/config';
import { DomainError, validation } from '@ocso/domain';
import { z } from 'zod';
import { Public, type OcsoRequest } from '../../common/decorators.js';
import { BLOB_STORE, ENV } from '../../infrastructure/tokens.js';
import { ChannelIngressService, toRawRequest } from '../channels/channel-ingress.service.js';
import { RealtimeHub } from '../realtime/realtime.hub.js';
import { WebChatIdentityService, type WebChatContext } from './webchat-identity.service.js';
import { WebChatMessagesService } from './webchat-messages.service.js';
import { modeOf } from './webchat-notices.js';
import { visitorStream } from './webchat-stream.js';

const SessionInput = z.object({ visitorToken: z.string().max(2048).optional(), hostToken: z.string().max(4096).optional() });
type SessionInput = z.infer<typeof SessionInput>;
const AfterQuery = z.object({ afterSeq: z.coerce.number().int().min(0).default(0) });
type AfterQuery = z.infer<typeof AfterQuery>;
/** Declared type for uploads whose real type has no raw body parser (sent as application/octet-stream). */
const DECLARED_TYPE = /^[a-z]+\/[a-z0-9.+-]{1,120}$/;

/**
 * Public customer web-chat API (docs/07 §4). Authenticated by channel-bound
 * visitor tokens (or host-app JWT exchange); customers only ever see
 * customer-visible messages of their own conversation. Browser calls must come
 * from OCSO's own origin (the widget iframe) or an allowed host origin.
 */
@Controller('public/webchat/:publicKey')
export class WebChatController {
  private readonly publicOrigin: string;

  constructor(
    @Inject(WebChatIdentityService) private readonly identity: WebChatIdentityService,
    @Inject(WebChatMessagesService) private readonly messages: WebChatMessagesService,
    @Inject(ChannelIngressService) private readonly ingress: ChannelIngressService,
    @Inject(RealtimeHub) private readonly hub: RealtimeHub,
    @Inject(BLOB_STORE) private readonly blobs: BlobStore,
    @Inject(ENV) env: ApiEnv,
  ) {
    this.publicOrigin = new URL(env.OCSO_PUBLIC_URL).origin;
  }

  /** Public widget configuration: branding, limits and the embedding allowlist (no secrets). */
  @Get('config')
  @Public()
  async config(@Param('publicKey') publicKey: string) {
    const ctx = await this.identity.channel(publicKey);
    const cfg = resolveWebChatConfig(ctx.config);
    const caps = ctx.adapter.capabilities(ctx.config);
    return {
      name: ctx.row.name,
      assistantName: await this.identity.assistantName(ctx),
      branding: cfg.settings.branding,
      inboundParts: caps.inboundParts,
      maxMediaBytes: caps.maxMediaBytes,
      allowedMimeTypes: caps.allowedMimeTypes,
      maxTextLength: caps.maxTextLength,
      maxAttachmentsPerMessage: cfg.settings.maxAttachmentsPerMessage,
      allowedOrigins: cfg.settings.allowedOrigins,
      hostIdentity: Boolean(cfg.hostJwtSecret),
    };
  }

  @Post('session')
  @Public()
  @HttpCode(200)
  async session(@Param('publicKey') publicKey: string, @Headers('origin') origin: string | undefined, @Body({ schema: SessionInput }) body: SessionInput) {
    const ctx = await this.channelFor(publicKey, origin);
    const cfg = resolveWebChatConfig(ctx.config);
    const now = new Date();
    let visitorId = newVisitorId();
    let externalCustomerRef: string | undefined;
    if (body.visitorToken && isVisitorToken(body.visitorToken)) {
      try {
        const claims = verifyVisitorToken(body.visitorToken, cfg.visitorTokenSecret, { channelId: cfg.channelId, now });
        visitorId = claims.visitorId;
        externalCustomerRef = claims.externalCustomerRef;
      } catch {
        // Expired or foreign token: start a new anonymous visitor.
      }
    }
    if (body.hostToken) {
      if (!cfg.hostJwtSecret) throw validation('host_auth_disabled', 'Authenticated customers are not enabled for this channel');
      const claims = verifyHostJwt(body.hostToken, cfg.hostJwtSecret, { issuer: cfg.settings.hostJwtIssuer, audience: cfg.settings.hostJwtAudience, now });
      externalCustomerRef = claims.customerRef;
    }
    const issued = issueVisitorToken({ channelId: cfg.channelId, visitorId, externalCustomerRef, ttlSeconds: cfg.settings.visitorTokenTtlSeconds }, cfg.visitorTokenSecret, now);
    return { token: issued.token, visitorId: issued.visitorId, expiresAt: issued.expiresAt.toISOString(), authenticated: Boolean(externalCustomerRef) };
  }

  @Post('messages')
  @Public()
  async send(@Param('publicKey') publicKey: string, @Headers('origin') origin: string | undefined, @Req() req: OcsoRequest & { rawBody?: Buffer }) {
    const ctx = await this.channelFor(publicKey, origin);
    const raw = toRawRequest('POST', req.headers, {}, req.rawBody);
    const verified = ctx.adapter.verifyRequest(raw, ctx.config);
    if (verified.kind === 'rejected') throw new DomainError(verified.status === 401 ? 'authentication' : 'authorization', 'webchat_token_invalid', verified.reason);
    const summary = await this.ingress.process(ctx.config.id, ctx.adapter.parseInbound(raw, ctx.config), req.correlationId ?? randomUUID());
    const result = summary.results[0];
    if (!result || result.status === 'rejected') throw validation('webchat_rejected', 'Message could not be accepted');
    return result;
  }

  /** History of the visitor's latest conversation: latest page, or the page after `afterSeq` (gap fill). */
  @Get('messages')
  @Public()
  async history(
    @Param('publicKey') publicKey: string,
    @Headers('origin') origin: string | undefined,
    @Headers('authorization') auth: string | undefined,
    @Query({ schema: AfterQuery }) q: AfterQuery,
  ) {
    const ctx = await this.channelFor(publicKey, origin);
    const visitor = this.identity.identify(ctx, auth);
    const conversation = await this.identity.conversationFor(ctx.config.id, visitor);
    if (!conversation) return { conversationId: null, agentName: await this.identity.assistantName(ctx), messages: [], notices: [], status: { mode: 'ai', humanName: null } };
    const caps = ctx.adapter.capabilities(ctx.config);
    const messages = await this.messages.list(conversation.id, caps, q.afterSeq, conversation.agentName);
    const fromSeq = q.afterSeq > 0 ? q.afterSeq + 1 : (messages[0]?.seq ?? 0);
    const mode = modeOf(conversation.controlState);
    return {
      conversationId: conversation.id,
      agentName: conversation.agentName,
      messages,
      notices: await this.messages.notices(conversation.id, fromSeq, conversation.agentName),
      status: { mode, humanName: mode === 'human' ? await this.messages.firstNameOf(conversation.assignedUserId) : null },
    };
  }

  /** Upload an attachment (raw body) into the visitor's own key prefix. */
  @Post('attachments')
  @Public()
  async upload(
    @Param('publicKey') publicKey: string,
    @Headers('origin') origin: string | undefined,
    @Headers('authorization') auth: string | undefined,
    @Headers('content-type') contentType: string | undefined,
    @Headers('x-ocso-content-type') declaredType: string | undefined,
    @Req() req: OcsoRequest & { body: unknown },
  ) {
    const ctx = await this.channelFor(publicKey, origin);
    const visitor = this.identity.identify(ctx, auth);
    const data = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : null;
    if (!data) throw validation('attachment_body_required', 'Send the file as the raw request body');
    const caps = ctx.adapter.capabilities(ctx.config);
    const allowed = Object.values(caps.allowedMimeTypes).flat();
    const octet = (contentType ?? '').split(';')[0]?.trim().toLowerCase() === 'application/octet-stream';
    const declared = octet && declaredType && DECLARED_TYPE.test(declaredType.toLowerCase()) ? declaredType.toLowerCase() : (contentType ?? 'application/octet-stream');
    const check = checkMedia(data, declared, allowed, Math.max(...Object.values(caps.maxMediaBytes)));
    if (!check.ok) throw validation('attachment_rejected', `Attachment rejected: ${check.reason}`, { reason: check.reason });
    const kind = mediaKindForMime(caps, check.mimeType);
    if (!kind || !caps.inboundParts.includes(kind) || data.byteLength > caps.maxMediaBytes[kind]) {
      throw validation('attachment_rejected', 'Attachment rejected: too_large', { reason: 'too_large', limitBytes: kind ? caps.maxMediaBytes[kind] : 0 });
    }
    const key = `${attachmentKeyPrefix(ctx.config.id, visitor)}${randomUUID()}.${extensionFor(check.mimeType)}`;
    const stored = await this.blobs.put({ key, data, contentType: check.mimeType, retention: 'CONVERSATION_MEDIA' });
    return { uploadId: stored.key, mimeType: stored.contentType, sizeBytes: stored.sizeBytes, sha256: stored.sha256 };
  }

  /** Customer stream: this visitor's messages, streamed AI text, typing and customer-safe notices (see webchat-stream.ts). */
  @Sse('stream')
  @Public()
  async stream(
    @Param('publicKey') publicKey: string,
    @Headers('origin') origin: string | undefined,
    @Headers('authorization') auth: string | undefined,
    @SseSignal() signal: AbortSignal,
  ): Promise<Observable<MessageEvent>> {
    const ctx = await this.channelFor(publicKey, origin);
    const visitor = this.identity.identify(ctx, auth);
    const events = visitorStream(
      { hub: this.hub, identity: this.identity, messages: this.messages },
      { channelId: ctx.config.id, visitor, capabilities: ctx.adapter.capabilities(ctx.config) },
    );
    const keepalive = interval(20_000).pipe(map((): MessageEvent => ({ type: 'ping', data: {} })));
    return merge(events, keepalive).pipe(takeUntil(fromEvent(signal, 'abort')));
  }

  /**
   * Resolve the channel and enforce the embedding allowlist for browser calls:
   * requests without an Origin (server-side, same-origin GET) pass; otherwise
   * the origin must be OCSO's own (the widget iframe) or an allowed host site.
   */
  private async channelFor(publicKey: string, origin: string | undefined): Promise<WebChatContext> {
    const ctx = await this.identity.channel(publicKey);
    if (!origin || origin === this.publicOrigin) return ctx;
    const { allowedOrigins } = resolveWebChatConfig(ctx.config).settings;
    if (allowedOrigins.length === 0 || originAllowed(origin, allowedOrigins)) return ctx;
    throw new DomainError('authorization', 'webchat_origin_not_allowed', 'This site is not allowed to use this chat');
  }
}
