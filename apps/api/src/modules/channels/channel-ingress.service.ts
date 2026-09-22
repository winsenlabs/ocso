import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { IngressService, MessageTemplateService, applyProviderTemplateUpdate, type IngressResult } from '@ocso/application';
import { ChannelRuntime } from '@ocso/agent-runtime';
import type { ChannelRegistry, InboundEnvelope, RawHttpRequest } from '@ocso/channels';
import { notFound } from '@ocso/domain';
import { channels, type Db } from '@ocso/db';
import { CHANNEL_REGISTRY, DB } from '../../infrastructure/tokens.js';

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
  ) {}

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
    for (const message of envelope.messages) {
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
