import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Sse, SseSignal, type MessageEvent } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable, filter, from, fromEvent, interval, map, merge, mergeMap, of, takeUntil } from 'rxjs';
import {
  attachmentKeyPrefix,
  isVisitorToken,
  issueVisitorToken,
  resolveWebChatConfig,
  verifyHostJwt,
  verifyVisitorToken,
  newVisitorId,
} from '@ocso/channels';
import { checkMedia, extensionFor, type BlobStore } from '@ocso/blob';
import { DomainError, validation } from '@ocso/domain';
import { z } from 'zod';
import { Public, type OcsoRequest } from '../../common/decorators.js';
import { BLOB_STORE } from '../../infrastructure/tokens.js';
import { ChannelIngressService, toRawRequest } from '../channels/channel-ingress.service.js';
import { RealtimeHub } from '../realtime/realtime.hub.js';
import { WebChatIdentityService } from './webchat-identity.service.js';
import { WebChatMessagesService } from './webchat-messages.service.js';

const SessionInput = z.object({ visitorToken: z.string().max(2048).optional(), hostToken: z.string().max(4096).optional() });
type SessionInput = z.infer<typeof SessionInput>;
const AfterQuery = z.object({ afterSeq: z.coerce.number().int().min(0).default(0) });
type AfterQuery = z.infer<typeof AfterQuery>;

/**
 * Public customer web-chat API (docs/07 §4). Authenticated by channel-bound
 * visitor tokens (or host-app JWT exchange); customers only ever see
 * customer-visible messages of their own conversation.
 */
@Controller('public/webchat/:publicKey')
export class WebChatController {
  constructor(
    @Inject(WebChatIdentityService) private readonly identity: WebChatIdentityService,
    @Inject(WebChatMessagesService) private readonly messages: WebChatMessagesService,
    @Inject(ChannelIngressService) private readonly ingress: ChannelIngressService,
    @Inject(RealtimeHub) private readonly hub: RealtimeHub,
    @Inject(BLOB_STORE) private readonly blobs: BlobStore,
  ) {}

  @Get('config')
  @Public()
  async config(@Param('publicKey') publicKey: string) {
    const ctx = await this.identity.channel(publicKey);
    const caps = ctx.adapter.capabilities(ctx.config);
    return { name: ctx.row.name, inboundParts: caps.inboundParts, maxMediaBytes: caps.maxMediaBytes, allowedMimeTypes: caps.allowedMimeTypes };
  }

  @Post('session')
  @Public()
  @HttpCode(200)
  async session(@Param('publicKey') publicKey: string, @Body({ schema: SessionInput }) body: SessionInput) {
    const ctx = await this.identity.channel(publicKey);
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
  async send(@Param('publicKey') publicKey: string, @Req() req: OcsoRequest & { rawBody?: Buffer }) {
    const ctx = await this.identity.channel(publicKey);
    const raw = toRawRequest('POST', req.headers, {}, req.rawBody);
    const verified = ctx.adapter.verifyRequest(raw, ctx.config);
    if (verified.kind === 'rejected') throw new DomainError(verified.status === 401 ? 'authentication' : 'authorization', 'webchat_token_invalid', verified.reason);
    const summary = await this.ingress.process(ctx.config.id, ctx.adapter.parseInbound(raw, ctx.config), req.correlationId ?? randomUUID());
    const result = summary.results[0];
    if (!result || result.status === 'rejected') throw validation('webchat_rejected', 'Message could not be accepted');
    return result;
  }

  @Get('messages')
  @Public()
  async history(@Param('publicKey') publicKey: string, @Headers('authorization') auth: string | undefined, @Query({ schema: AfterQuery }) q: AfterQuery) {
    const ctx = await this.identity.channel(publicKey);
    const visitor = this.identity.identify(ctx, auth);
    const conversation = await this.identity.conversationFor(ctx.config.id, visitor);
    if (!conversation) return { conversationId: null, messages: [] };
    const caps = ctx.adapter.capabilities(ctx.config);
    return { conversationId: conversation.id, agentName: conversation.agentName, messages: await this.messages.list(conversation.id, caps, q.afterSeq, conversation.agentName) };
  }

  /** Upload an attachment (raw body) into the visitor's own key prefix. */
  @Post('attachments')
  @Public()
  async upload(@Param('publicKey') publicKey: string, @Headers('authorization') auth: string | undefined, @Headers('content-type') contentType: string | undefined, @Req() req: OcsoRequest & { body: unknown }) {
    const ctx = await this.identity.channel(publicKey);
    const visitor = this.identity.identify(ctx, auth);
    const data = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : null;
    if (!data) throw validation('attachment_body_required', 'Send the file as the raw request body');
    const caps = ctx.adapter.capabilities(ctx.config);
    const allowed = Object.values(caps.allowedMimeTypes).flat();
    const max = Math.max(...Object.values(caps.maxMediaBytes));
    const check = checkMedia(data, contentType ?? 'application/octet-stream', allowed, max);
    if (!check.ok) throw validation('attachment_rejected', `Attachment rejected: ${check.reason}`);
    const key = `${attachmentKeyPrefix(ctx.config.id, visitor)}${randomUUID()}.${extensionFor(check.mimeType)}`;
    const stored = await this.blobs.put({ key, data, contentType: check.mimeType, retention: 'CONVERSATION_MEDIA' });
    return { uploadId: stored.key, mimeType: stored.contentType, sizeBytes: stored.sizeBytes, sha256: stored.sha256 };
  }

  /** Customer stream: new messages, streamed AI text and typing status for this visitor only. */
  @Sse('stream')
  @Public()
  async stream(@Param('publicKey') publicKey: string, @Headers('authorization') auth: string | undefined, @SseSignal() signal: AbortSignal): Promise<Observable<MessageEvent>> {
    const ctx = await this.identity.channel(publicKey);
    const visitor = this.identity.identify(ctx, auth);
    const caps = ctx.adapter.capabilities(ctx.config);
    // Resolve the visitor's conversation once; re-check at most once per second
    // (a first message creates it after the stream opened).
    let current = await this.identity.conversationFor(ctx.config.id, visitor);
    let lastLookup = Date.now();
    const mine = async (conversationId: string | undefined) => {
      if (!conversationId) return false;
      if (current?.id !== conversationId && Date.now() - lastLookup > 1_000) {
        lastLookup = Date.now();
        current = await this.identity.conversationFor(ctx.config.id, visitor);
      }
      return current?.id === conversationId ? current : false;
    };
    const events = this.hub.stream((e) => ['interaction.sent', 'human.message_sent', 'agent.response_delta', 'agent.status', 'handoff.requested', 'conversation.control_changed'].includes(e.type)).pipe(
      mergeMap((e) => from(mine(e.conversationId)).pipe(mergeMap((conv) => (conv ? of({ e, conv }) : [])))),
      mergeMap(({ e, conv }) => from(this.toCustomerEvent(e, caps, conv.agentName))),
      filter((m): m is MessageEvent => m !== null),
    );
    const keepalive = interval(20_000).pipe(map((): MessageEvent => ({ type: 'ping', data: {} })));
    return merge(of<MessageEvent>({ type: 'ready', data: {} }), events, keepalive).pipe(takeUntil(fromEvent(signal, 'abort')));
  }

  private async toCustomerEvent(e: { type: string; payload: unknown }, caps: Parameters<WebChatMessagesService['one']>[1], agentName: string): Promise<MessageEvent | null> {
    const p = e.payload as Record<string, unknown>;
    if (e.type === 'interaction.sent' || e.type === 'human.message_sent') {
      const message = await this.messages.one(String(p['interactionId']), caps, agentName);
      return message ? { type: 'message', data: message } : null;
    }
    if (e.type === 'agent.response_delta') return { type: 'delta', data: { turnId: p['turnId'], text: p['delta'] } };
    if (e.type === 'agent.status') return { type: 'typing', data: { turnId: p['turnId'] } };
    if (e.type === 'conversation.control_changed' && p['to'] === 'HUMAN_ACTIVE') return { type: 'notice', data: { text: 'A colleague has joined the conversation.' } };
    return null;
  }
}
