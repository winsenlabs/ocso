import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Sse, SseSignal, type MessageEvent } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable, fromEvent, interval, map, merge, takeUntil } from 'rxjs';
import { mediaKindForMime, type EmbedSessionPass, type EmbedVisitor } from '@ocso/channels';
import { checkMedia, extensionFor, type BlobStore } from '@ocso/blob';
import { consumeSessionPassId, holdUserToken } from '@ocso/application';
import { DomainError, notFound, validation } from '@ocso/domain';
import type { Db } from '@ocso/db';
import { z } from 'zod';
import { Public, type OcsoRequest } from '../../common/decorators.js';
import { BLOB_STORE, DB } from '../../infrastructure/tokens.js';
import { ChannelIngressService, toRawRequest } from '../channels/channel-ingress.service.js';
import { RealtimeHub } from '../realtime/realtime.hub.js';
import { WebChatIdentityService, type WebChatContext } from './webchat-identity.service.js';
import { WebChatMessagesService } from './webchat-messages.service.js';
import { modeOf } from './webchat-notices.js';
import { visitorStream } from './webchat-stream.js';
import { WebChatRateLimiter } from './webchat-rate-limit.js';

const Context = z.record(z.string().max(64), z.union([z.string().max(1_024), z.number(), z.boolean()]));
const SessionInput = z.object({
  visitorToken: z.string().max(12_288).optional(),
  hostToken: z.string().max(8_192).optional(),
  sessionPass: z.string().max(16_384).optional(),
  userToken: z.string().max(8_192).optional(),
  context: Context.optional(),
});
const SessionPassInput = z.object({
  userToken: z.string().max(8_192).optional(),
  context: Context.optional(),
  visitorId: z.string().max(128).optional(),
  ttlSeconds: z.number().int().min(60).max(3_600).optional(),
});
type SessionPassInput = z.infer<typeof SessionPassInput>;
type SessionInput = z.infer<typeof SessionInput>;
const AfterQuery = z.object({ afterSeq: z.coerce.number().int().min(0).default(0) });
type AfterQuery = z.infer<typeof AfterQuery>;
/** Declared type for uploads whose real type has no raw body parser (sent as application/octet-stream). */
const DECLARED_TYPE = /^[a-z]+\/[a-z0-9.+-]{1,120}$/;

/**
 * Public customer web-chat API (docs/07 §4, SPEC §C) for every `embeddable`
 * channel kind. Authenticated by the kind's visitor tokens (the adapter's
 * `embed` hooks: channel-bound visitor tokens, session passes, user tokens);
 * customers only ever see customer-visible messages of their own
 * conversation. Browser calls must come from OCSO's own origin (the widget
 * iframe) or an allowed site; calls without an Origin need native apps
 * allowed or a non-anonymous auth mode (see webchat-access.ts). CORS is the
 * WebChatCorsMiddleware; rate limits are per instance (webchat-rate-limit.ts).
 */
@Controller('public/webchat/:publicKey')
export class WebChatController {
  constructor(
    @Inject(WebChatIdentityService) private readonly identity: WebChatIdentityService,
    @Inject(WebChatMessagesService) private readonly messages: WebChatMessagesService,
    @Inject(ChannelIngressService) private readonly ingress: ChannelIngressService,
    @Inject(RealtimeHub) private readonly hub: RealtimeHub,
    @Inject(BLOB_STORE) private readonly blobs: BlobStore,
    @Inject(DB) private readonly db: Db,
    @Inject(WebChatRateLimiter) private readonly limits: WebChatRateLimiter,
  ) {}

  /** Public widget configuration: branding, limits and the embedding allowlist (no secrets). */
  @Get('config')
  @Public()
  async config(@Param('publicKey') publicKey: string, @Headers('origin') origin: string | undefined, @Req() req: OcsoRequest) {
    const ctx = await this.identity.access(req, publicKey, origin);
    const widget = ctx.embed.widgetConfig(ctx.config);
    const caps = ctx.adapter.capabilities(ctx.config);
    return {
      name: ctx.row.name,
      assistantName: await this.identity.assistantName(ctx),
      branding: widget.branding,
      inboundParts: caps.inboundParts,
      maxMediaBytes: caps.maxMediaBytes,
      allowedMimeTypes: caps.allowedMimeTypes,
      maxTextLength: caps.maxTextLength,
      maxAttachmentsPerMessage: widget.maxAttachmentsPerMessage,
      allowedOrigins: widget.allowedOrigins,
      hostIdentity: widget.hostIdentity,
      authMode: widget.authMode,
    };
  }

  /**
   * Server-to-server (never CORS-enabled): the site's backend presents the channel secret key as the bearer
   * and gets a short-lived, single-use session pass, optionally for a verified user with trusted context.
   */
  @Post('session-pass')
  @Public()
  @HttpCode(201)
  async sessionPass(
    @Param('publicKey') publicKey: string,
    @Headers('origin') origin: string | undefined,
    @Headers('authorization') auth: string | undefined,
    @Req() req: OcsoRequest,
    @Body({ schema: SessionPassInput }) body: SessionPassInput,
  ) {
    if (origin) throw new DomainError('authorization', 'webchat_session_pass_server_only', 'Mint session passes from your server; never from a browser');
    const ctx = await this.identity.channelForRequest(req, publicKey);
    if (!ctx.embed.mintSessionPass) throw notFound('session_pass', publicKey);
    const secretKey = /^Bearer\s+(\S+)\s*$/i.exec(auth ?? '')?.[1];
    let minted: EmbedSessionPass;
    try {
      minted = await ctx.embed.mintSessionPass(ctx.config, { secretKey, ...body });
    } catch (err) {
      // A wrong secret key spends the caller's own (channel + address) budget, never the channel's:
      // the publishable key is public, so anyone could otherwise starve the site's backend.
      if (err instanceof DomainError && err.code === 'secret_key_invalid') this.limits.take('sessionPassFailures', `${ctx.config.id}:${req.ip ?? 'unknown'}`);
      throw err;
    }
    // No per-channel limit on successful mints: the caller proved it holds the secret key, and every page view
    // of a client/user-mode site mints one. Only wrong keys are limited (per channel + address, above).
    if (minted.userToken) {
      const { sealed, expiresAt, visitor } = minted.userToken;
      await holdUserToken(this.db, { channelId: ctx.config.id, identity: visitor, visitorId: body.visitorId, sealed, expiresAt, now: new Date() });
    }
    return { sessionPass: minted.sessionPass, expiresAt: minted.expiresAt.toISOString() };
  }

  @Post('session')
  @Public()
  @HttpCode(200)
  async session(@Param('publicKey') publicKey: string, @Headers('origin') origin: string | undefined, @Req() req: OcsoRequest, @Body({ schema: SessionInput }) body: SessionInput) {
    const ctx = await this.identity.access(req, publicKey, origin);
    this.limits.take('session', `${ctx.config.id}:${req.ip ?? 'unknown'}`);
    const channelId = ctx.config.id;
    const session = await ctx.embed.openSession(ctx.config, body, { consumeOnce: (jti, expiresAt) => consumeSessionPassId(this.db, channelId, jti, expiresAt) });
    if (session.userToken) {
      await holdUserToken(this.db, { channelId, identity: session.visitor, visitorId: session.visitorId, sealed: session.userToken.sealed, expiresAt: session.userToken.expiresAt, now: new Date() });
    }
    return { token: session.token, visitorId: session.visitorId, expiresAt: session.expiresAt.toISOString(), authenticated: session.authenticated };
  }

  @Post('messages')
  @Public()
  async send(@Param('publicKey') publicKey: string, @Headers('origin') origin: string | undefined, @Req() req: OcsoRequest & { rawBody?: Buffer }) {
    const ctx = await this.identity.access(req, publicKey, origin);
    const raw = toRawRequest('POST', req.headers, {}, req.rawBody);
    const verified = await ctx.adapter.verifyRequest(raw, ctx.config);
    if (verified.kind === 'rejected') throw new DomainError(verified.status === 401 ? 'authentication' : 'authorization', 'webchat_token_invalid', verified.reason);
    this.limitVisitor('messages', ctx, await this.identity.identify(ctx, req.headers.authorization));
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
    @Req() req: OcsoRequest,
  ) {
    const ctx = await this.identity.access(req, publicKey, origin);
    const visitor = await this.identity.identify(ctx, auth);
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
    const ctx = await this.identity.access(req, publicKey, origin);
    const visitor = await this.identity.identify(ctx, auth);
    this.limitVisitor('attachments', ctx, visitor);
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
    const key = `${ctx.embed.attachmentKeyPrefix(ctx.config, visitor)}${randomUUID()}.${extensionFor(check.mimeType)}`;
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
    @Req() req: OcsoRequest,
  ): Promise<Observable<MessageEvent>> {
    const ctx = await this.identity.access(req, publicKey, origin);
    const visitor = await this.identity.identify(ctx, auth);
    this.limitVisitor('stream', ctx, visitor);
    const events = visitorStream(
      { hub: this.hub, identity: this.identity, messages: this.messages },
      { channelId: ctx.config.id, visitor, capabilities: ctx.adapter.capabilities(ctx.config) },
    );
    const keepalive = interval(20_000).pipe(map((): MessageEvent => ({ type: 'ping', data: {} })));
    return merge(events, keepalive).pipe(takeUntil(fromEvent(signal, 'abort')));
  }

  /** Per-visitor limits key on the caller's identity (a visitor, or the verified user across devices). */
  private limitVisitor(limit: 'messages' | 'attachments' | 'stream', ctx: WebChatContext, visitor: EmbedVisitor): void {
    this.limits.take(limit, `${ctx.config.id}:${visitor.identityKind}:${visitor.identityValue}`);
  }
}
