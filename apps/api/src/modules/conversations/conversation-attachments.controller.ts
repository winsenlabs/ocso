import { randomUUID } from 'node:crypto';
import { Controller, Headers, Inject, Param, Post, Req } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Permission } from '@ocso/auth';
import { ChannelRuntime } from '@ocso/agent-runtime';
import { staffAttachmentPrefix, type ActorContext } from '@ocso/application';
import { checkMedia, extensionFor, type BlobStore } from '@ocso/blob';
import { mediaKindForMime } from '@ocso/channels';
import { conversations, type Db } from '@ocso/db';
import { notFound, validation } from '@ocso/domain';
import { z } from 'zod';
import { Actor, RequirePermission } from '../../common/decorators.js';
import { BLOB_STORE, DB } from '../../infrastructure/tokens.js';
import { ConversationAccessService } from './conversation-access.service.js';

const Id = z.uuid();
const DECLARED_TYPE = /^[a-z]+\/[a-z0-9.+-]+$/;
const FILENAME = /^[\w .()\-]{1,120}$/u;

/**
 * Staff reply attachments (design/01 composer). Validated against the
 * conversation channel's outbound limits and stored under the conversation's
 * staff prefix — the only keys a reply may reference.
 */
@Controller('v1/conversations')
export class ConversationAttachmentsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BLOB_STORE) private readonly blobs: BlobStore,
    @Inject(ChannelRuntime) private readonly channels: ChannelRuntime,
    @Inject(ConversationAccessService) private readonly access: ConversationAccessService,
  ) {}

  @Post(':id/attachments')
  @RequirePermission(Permission.CONVERSATIONS_REPLY)
  async upload(
    @Actor() actor: ActorContext,
    @Param('id', { schema: Id }) id: string,
    @Headers('content-type') contentType: string | undefined,
    @Headers('x-ocso-content-type') declaredType: string | undefined,
    @Headers('x-ocso-filename') rawFilename: string | undefined,
    @Req() req: { body: unknown },
  ) {
    await this.access.assert(actor.principal!, id);
    const [conv] = await this.db.select({ channelId: conversations.channelId }).from(conversations).where(eq(conversations.id, id));
    if (!conv?.channelId) throw notFound('conversation', id);
    const data = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : null;
    if (!data) throw validation('attachment_body_required', 'Send the file as the raw request body');
    const { adapter, config } = await this.channels.load(conv.channelId);
    const caps = adapter.capabilities(config);
    const octet = (contentType ?? '').split(';')[0]?.trim().toLowerCase() === 'application/octet-stream';
    const declared = octet && declaredType && DECLARED_TYPE.test(declaredType.toLowerCase()) ? declaredType.toLowerCase() : (contentType ?? 'application/octet-stream');
    const allowed = Object.values(caps.allowedMimeTypes).flat();
    const check = checkMedia(data, declared, allowed, Math.max(...Object.values(caps.maxMediaBytes)));
    if (!check.ok) throw validation('attachment_rejected', `Attachment rejected: ${check.reason}`, { reason: check.reason });
    const kind = mediaKindForMime(caps, check.mimeType);
    if (!kind || !caps.outboundParts.includes(kind) || data.byteLength > caps.maxMediaBytes[kind]) {
      throw validation('attachment_rejected', 'This channel cannot send that attachment', { reason: 'unsupported_or_too_large', limitBytes: kind ? caps.maxMediaBytes[kind] : 0 });
    }
    const filename = rawFilename ? decodeURIComponent(rawFilename).trim() : undefined;
    const stored = await this.blobs.put({ key: `${staffAttachmentPrefix(id)}${randomUUID()}.${extensionFor(check.mimeType)}`, data, contentType: check.mimeType, retention: 'CONVERSATION_MEDIA' });
    return {
      partType: kind,
      media: { blobKey: stored.key, mimeType: stored.contentType, sizeBytes: stored.sizeBytes, sha256: stored.sha256, status: 'STORED' as const, ...(filename && FILENAME.test(filename) ? { filename } : {}) },
    };
  }
}
