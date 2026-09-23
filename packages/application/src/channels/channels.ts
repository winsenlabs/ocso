import { randomBytes } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import { Permission, assertCan } from '@ocso/auth';
import { notFound, validation } from '@ocso/domain';
import { channels, routers, uuidv7, type Db } from '@ocso/db';
import { passThroughAgentOf } from '../routing/reach.js';
import type { SecretStore } from '@ocso/secrets';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { bumpGeneration } from '../cache/generations.js';
import type { ActorContext } from '../shared/context.js';
import { patchOf } from '../shared/patch.js';

export const ChannelInput = z.object({
  /** A registered channel adapter kind (open: the API checks it against the channel registry; plugins add kinds). */
  kind: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'must be a channel kind (upper snake case)'),
  name: z.string().trim().min(1).max(120),
  settings: z.record(z.string(), z.unknown()).default({}),
  /** Plaintext secrets entered once by the admin; stored in the SecretStore, never returned. */
  secrets: z.record(z.string(), z.string().min(1).max(8_000)).default({}),
  status: z.enum(['ACTIVE', 'DISABLED', 'DRAFT']).default('DRAFT'),
});
export type ChannelInput = z.infer<typeof ChannelInput>;
export const ChannelPatch = patchOf(ChannelInput.omit({ kind: true }));
export type ChannelPatch = z.infer<typeof ChannelPatch>;

export interface ChannelView {
  id: string;
  kind: string;
  name: string;
  status: string;
  publicKey: string;
  settings: Record<string, unknown>;
  /** Names of configured secrets and their refs — never values. */
  secretRefs: Record<string, string>;
  /** The router customers of this channel go through (PM/research/11 §5); set by router approval. */
  router: { id: string; name: string; status: string } | null;
  /**
   * Derived, read-only: the agent a pass-through router answers as (null for routers that ask first, or none).
   * The deprecated `channels.default_agent_id` column is no longer read or written.
   */
  defaultAgentId: string | null;
  lastInboundAt: string | null;
  /** Where the provider posts inbound messages (`/channels/<segment>/<publicKey>/webhook`), for webhook kinds. */
  webhookPath: string | null;
  /** The widget page customers open (`/chat/<publicKey>`), for embeddable kinds. */
  embedPath: string | null;
}

/** Validates settings + secrets for a channel kind (provided by the channel adapter registry). */
export type ChannelConfigValidator = (kind: string, settings: unknown, secrets: Record<string, string>) => string[];
/** Public paths of a channel (provider webhook, widget page), from the channel adapter registry. */
export type ChannelPathResolver = (kind: string, publicKey: string) => { webhookPath: string | null; embedPath: string | null };

export class ChannelService {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
    private readonly validate: ChannelConfigValidator,
    private readonly paths: ChannelPathResolver,
  ) {}

  async list(): Promise<ChannelView[]> {
    const rows = await this.db.select().from(channels).orderBy(asc(channels.name));
    return this.views(rows);
  }

  async get(id: string): Promise<ChannelView> {
    const [row] = await this.db.select().from(channels).where(eq(channels.id, id));
    if (!row) throw notFound('channel', id);
    return (await this.views([row]))[0]!;
  }

  private async views(rows: Array<typeof channels.$inferSelect>): Promise<ChannelView[]> {
    const routerIds = [...new Set(rows.flatMap((r) => (r.routerId ? [r.routerId] : [])))];
    const [routerRows, agents] = await Promise.all([
      routerIds.length ? this.db.select({ id: routers.id, name: routers.name, status: routers.status }).from(routers).where(inArray(routers.id, routerIds)) : Promise.resolve([]),
      passThroughAgentOf(this.db, rows.map((r) => r.id)),
    ]);
    return rows.map((row) => this.toView(row, routerRows.find((r) => r.id === row.routerId) ?? null, agents.get(row.id) ?? null));
  }

  /** Resolve a channel's secret values for trusted adapter code. */
  async resolveSecrets(channel: { secretRefs: Record<string, string> }): Promise<Record<string, string>> {
    const entries = await Promise.all(Object.entries(channel.secretRefs).map(async ([k, ref]) => [k, await this.secrets.resolve(ref)] as const));
    return Object.fromEntries(entries);
  }

  async create(actor: ActorContext, input: ChannelInput): Promise<ChannelView> {
    assertCan(actor.principal!, Permission.CHANNELS_MANAGE);
    const problems = this.validate(input.kind, input.settings, input.secrets);
    if (problems.length && input.status === 'ACTIVE') throw validation('invalid_channel_config', problems.join('; '));
    const id = uuidv7();
    const secretRefs = await this.storeSecrets(input.name, input.secrets);
    const [row] = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(channels)
        .values({
          id,
          kind: input.kind,
          name: input.name,
          status: input.status,
          publicKey: randomBytes(12).toString('base64url'),
          settings: input.settings,
          secretRefs,
        })
        .returning();
      await recordAudit(tx, actor, {
        action: 'channel.create',
        targetType: 'channel',
        targetId: id,
        summary: `Created ${input.kind} channel ${input.name}`,
        after: { ...input, secrets: Object.keys(input.secrets) },
      });
      return inserted;
    });
    return (await this.views([row!]))[0]!;
  }

  async update(actor: ActorContext, id: string, patch: ChannelPatch): Promise<ChannelView> {
    assertCan(actor.principal!, Permission.CHANNELS_MANAGE);
    const [before] = await this.db.select().from(channels).where(eq(channels.id, id));
    if (!before) throw notFound('channel', id);
    const newRefs = patch.secrets ? await this.storeSecrets(patch.name ?? before.name, patch.secrets) : {};
    const secretRefs = { ...before.secretRefs, ...newRefs };
    const settings = patch.settings ?? before.settings;
    const status = patch.status ?? before.status;
    if (status === 'ACTIVE') {
      const resolved = await this.resolveSecrets({ secretRefs });
      const problems = this.validate(before.kind, settings, resolved);
      if (problems.length) throw validation('invalid_channel_config', problems.join('; '));
    }
    const [row] = await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(channels)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          settings,
          status,
          secretRefs,
          updatedAt: new Date(),
        })
        .where(eq(channels.id, id))
        .returning();
      await recordAudit(tx, actor, {
        action: 'channel.update',
        targetType: 'channel',
        targetId: id,
        summary: `Updated channel ${before.name}`,
        before: { ...before, secretRefs: Object.keys(before.secretRefs) },
        after: { ...patch, secrets: patch.secrets ? Object.keys(patch.secrets) : undefined },
      });
      await bumpGeneration(tx, actor.correlationId, `channel:${id}`, 'channel_behavior_changed');
      return updated;
    });
    // Replaced secrets are deleted only after the new refs are committed.
    for (const [key, ref] of Object.entries(before.secretRefs)) {
      if (newRefs[key] && newRefs[key] !== ref) await this.secrets.delete(ref).catch(() => {});
    }
    return (await this.views([row!]))[0]!;
  }

  private async storeSecrets(channelName: string, values: Record<string, string>): Promise<Record<string, string>> {
    const refs: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      const meta = await this.secrets.put({ name: `${channelName} ${key}`, kind: 'CHANNEL_TOKEN', value, usedBy: `channel:${channelName}` });
      refs[key] = meta.ref;
    }
    return refs;
  }

  private toView(row: typeof channels.$inferSelect, router: ChannelView['router'], passThroughAgentId: string | null): ChannelView {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      status: row.status,
      publicKey: row.publicKey,
      settings: row.settings,
      secretRefs: row.secretRefs,
      router,
      defaultAgentId: passThroughAgentId,
      lastInboundAt: row.lastInboundAt?.toISOString() ?? null,
      ...this.paths(row.kind, row.publicKey),
    };
  }
}

