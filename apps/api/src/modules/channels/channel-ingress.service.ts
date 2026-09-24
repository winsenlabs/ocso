import { Inject, Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import { IngressService, MessageTemplateService, applyProviderTemplateUpdate, type IngressResult } from '@ocso/application';
import { ChannelRuntime } from '@ocso/agent-runtime';
import type { ChannelRegistry, InboundEnvelope, RawHttpRequest } from '@ocso/channels';
import { notFound } from '@ocso/domain';
import { channels, type Db } from '@ocso/db';
import { CHANNEL_REGISTRY, DB } from '../../infrastructure/tokens.js';
import { StaffChatService } from '../internal-agent/staff-chat.service.js';

export interface IngressSummary {
  accepted: number;
  duplicates: number;
  rejected: number;
  statuses: number;
  identityUpdates: number;
  templateUpdates: number;
  results: IngressResult[];
}

/**
 * Shared webhook → ingress bridge for every channel kind. Verification and
 * parsing belong to the adapter; persistence happens before we acknowledge.
 */
@Injectable()
export class ChannelIngressService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ChannelRuntime) private readonly runtime: ChannelRuntime,
    @Inject(IngressService) private readonly ingress: IngressService,
    @Inject(CHANNEL_REGISTRY) private readonly registry: ChannelRegistry,
    @Inject(MessageTemplateService) private readonly templates: MessageTemplateService,
    /** Resolved lazily: Ask OCSO's module is not a dependency of the channels module (narrow apps have neither). */
    @Optional() @Inject(ModuleRef) private readonly modules: ModuleRef | null = null,
  ) {}

  /** Ask OCSO's chat service when this channel's destination is Ask OCSO (a staff-destination kind set to `ask_ocso`). */
  private async staffChat(channelId: string): Promise<StaffChatService | null> {
    const [row] = await this.db.select({ kind: channels.kind, settings: channels.settings }).from(channels).where(eq(channels.id, channelId));
    if (!row || this.registry.destination(row.kind, row.settings) !== 'ask_ocso') return null;
    // Never fall back to customer ingress: a staff channel's messages must not become customer conversations.
    if (!this.modules) throw new Error(`channel ${channelId} sends to Ask OCSO, which this process does not run`);
    return this.modules.get(StaffChatService, { strict: false });
  }

  async resolve(publicKey: string, kind: string) {
    const [row] = await this.db.select({ id: channels.id, kind: channels.kind }).from(channels).where(eq(channels.publicKey, publicKey));
    if (!row || row.kind !== kind) throw notFound('channel', publicKey);
    return this.runtime.load(row.id);
  }

  /** Channel behind `/channels/<segment>/<publicKey>/webhook`; 404 unless the segment's kind owns that key. */
  async resolveWebhook(segment: string, publicKey: string) {
    const kind = this.registry.kindForWebhookSegment(segment);
    if (!kind) throw notFound('channel', publicKey);
    return this.resolve(publicKey, kind);
  }

  async process(channelId: string, envelope: InboundEnvelope, correlationId: string): Promise<IngressSummary> {
    const summary: IngressSummary = { accepted: 0, duplicates: 0, rejected: 0, statuses: 0, identityUpdates: 0, templateUpdates: 0, results: [] };
    // Template review results pushed by the provider; the worker's poller covers providers that only offer polling.
    for (const update of envelope.templateUpdates ?? []) {
      if (await applyProviderTemplateUpdate(this.db, channelId, update, { correlationId, now: update.occurredAt })) summary.templateUpdates++;
    }
    if (envelope.templateUpdates?.length) this.templates.invalidate(channelId);
    for (const update of envelope.identityUpdates ?? []) {
      if (await this.ingress.applyIdentityUpdate(update.identityKind, update.previousValue, update.currentValue)) summary.identityUpdates++;
    }
    // A staff chat channel (destination Ask OCSO): messages go to Ask OCSO as the linked staff member, never to customers.
    const staff = envelope.messages.length ? await this.staffChat(channelId) : null;
    if (staff) {
      const taken = await staff.receive(channelId, envelope.messages, correlationId);
      summary.accepted += taken.accepted;
      summary.duplicates += taken.duplicates;
    }
    for (const message of staff ? [] : envelope.messages) {
      const result = await this.ingress.receive(channelId, message, correlationId);
      summary.results.push(result);
      if (result.status === 'accepted') summary.accepted++;
      else if (result.status === 'duplicate') summary.duplicates++;
      else summary.rejected++;
    }
    if (envelope.statuses.length) summary.statuses = await this.ingress.receiveStatuses(channelId, envelope.statuses, correlationId);
    return summary;
  }
}

/** Build the transport-neutral request adapters expect (lower-cased headers, raw body, public URL for URL-bound signatures). */
export function toRawRequest(
  method: 'GET' | 'POST',
  headers: Record<string, string | string[] | undefined>,
  query: Record<string, unknown>,
  rawBody: Buffer | undefined,
  url?: string,
): RawHttpRequest {
  const flat: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) flat[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : v;
  const q: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(query)) q[k] = typeof v === 'string' ? v : undefined;
  return { method, headers: flat, query: q, rawBody: rawBody ?? null, ...(url ? { url } : {}) };
}
