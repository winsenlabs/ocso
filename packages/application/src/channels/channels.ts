import { randomBytes } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { Permission, assertCan } from '@ocso/auth';
import { notFound, validation } from '@ocso/domain';
import { agentChannels, channels, uuidv7, type Db } from '@ocso/db';
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
  defaultAgentId: z.uuid().nullable().default(null),
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
    return rows.map((row) => this.toView(row));
  }

  async get(id: string): Promise<ChannelView> {
    const [row] = await this.db.select().from(channels).where(eq(channels.id, id));
    if (!row) throw notFound('channel', id);
    return this.toView(row);
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
          defaultAgentId: input.defaultAgentId,
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
    return this.toView(row!);
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
          ...(patch.defaultAgentId !== undefined ? { defaultAgentId: patch.defaultAgentId } : {}),
          settings,
          status,
          secretRefs,
          updatedAt: new Date(),
        })
        .where(eq(channels.id, id))
        .returning();
      // A channel answers as exactly one agent: keep its attachment (agent_channels, the agent's
      // Channels tab) in step with the agent chosen here.
      if (patch.defaultAgentId !== undefined && patch.defaultAgentId !== before.defaultAgentId) {
        await tx.delete(agentChannels).where(eq(agentChannels.channelId, id));
        if (patch.defaultAgentId) await tx.insert(agentChannels).values({ agentId: patch.defaultAgentId, channelId: id });
      }
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
    return this.toView(row!);
  }

  private async storeSecrets(channelName: string, values: Record<string, string>): Promise<Record<string, string>> {
    const refs: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      const meta = await this.secrets.put({ name: `${channelName} ${key}`, kind: 'CHANNEL_TOKEN', value, usedBy: `channel:${channelName}` });
      refs[key] = meta.ref;
    }
    return refs;
  }

  private toView(row: typeof channels.$inferSelect): ChannelView {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      status: row.status,
      publicKey: row.publicKey,
      settings: row.settings,
      secretRefs: row.secretRefs,
      defaultAgentId: row.defaultAgentId,
      lastInboundAt: row.lastInboundAt?.toISOString() ?? null,
      ...this.paths(row.kind, row.publicKey),
    };
  }
}

