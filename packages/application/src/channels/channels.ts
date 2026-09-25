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
import { assertPlatformWrite, discardSecrets } from '../settings/platform-approvals.js';
import { stageSecrets, unstageSecrets } from '../settings/secret-refs.js';
import type { ChannelChange } from './channel-approval.js';

export const ChannelInput = z.object({
  /** A registered channel adapter kind (open: the API checks it against the channel registry; plugins add kinds). */
  kind: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'must be a channel kind (upper snake case)'),
  name: z.string().trim().min(1).max(120),
  settings: z.record(z.string(), z.unknown()).default({}),
  /** Plaintext secrets entered once by the admin; stored in the SecretStore, never returned. */
  secrets: z.record(z.string(), z.string().min(1).max(8_000)).default({}),
  /**
   * A new channel is a DRAFT. ACTIVE asks for activation (a proposal: the API needs `approval`); on PATCH,
   * DISABLED is the immediate stop and ACTIVE resumes (a proposal).
   */
  status: z.enum(['ACTIVE', 'DISABLED', 'DRAFT']).default('DRAFT'),
});
export type ChannelInput = z.infer<typeof ChannelInput>;
export const ChannelPatch = patchOf(ChannelInput.omit({ kind: true }));
export type ChannelPatch = z.infer<typeof ChannelPatch>;
/** What a person edits (the status moves through disable() and approvals). */
export type ChannelEdit = Omit<ChannelPatch, 'status'>;

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

/**
 * A draft is inert (ingress refuses it, and activation validates the whole configuration), so it may be
 * incomplete: problems about a setting or secret that was not given at all are set aside. A value that was
 * given is always checked, so a draft never stores a malformed one. Anything else is returned as is.
 */
export function draftProblems(problems: readonly string[], settings: unknown, secrets: Readonly<Record<string, string>>, draft: boolean): string[] {
  if (!draft) return [...problems];
  const given = (record: unknown, key: string) => {
    if (!record || typeof record !== 'object') return false;
    const value = (record as Record<string, unknown>)[key];
    return value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '');
  };
  return problems.filter((problem) => {
    const m = /^(settings|secrets)\.([A-Za-z0-9_]+)(?:[.:\s]|$)/.exec(problem);
    if (!m) return true;
    return m[1] === 'settings' ? given(settings, m[2]!) : given(secrets, m[2]!);
  });
}

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

  /**
   * A new channel is always a DRAFT: inert (ingress refuses it) until its ACTIVATE proposal is approved. Every
   * value given is checked on save (the provider's problems land on the form); values not given yet may be
   * missing (the admin creates the draft first to get its webhook URL), and activation checks everything.
   */
  async create(actor: ActorContext, input: ChannelInput): Promise<ChannelView> {
    assertCan(actor.principal!, Permission.CHANNELS_MANAGE);
    // A draft may be saved before the provider's values exist (its webhook URL is needed to create them);
    // one submitted for activation straight away must be complete.
    const problems = draftProblems(this.validate(input.kind, input.settings, input.secrets), input.settings, input.secrets, input.status !== 'ACTIVE');
    if (problems.length) throw validation('invalid_channel_config', problems.join('; '));
    const id = uuidv7();
    const secretRefs = await this.storeSecrets(input.name, input.secrets);
    const [row] = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(channels)
        .values({
          id,
          kind: input.kind,
          name: input.name,
          status: 'DRAFT',
          publicKey: randomBytes(12).toString('base64url'),
          settings: input.settings,
          secretRefs,
        })
        .returning();
      await recordAudit(tx, actor, {
        action: 'channel.create',
        redaction: 'settings',
        targetType: 'channel',
        targetId: id,
        summary: `Created ${input.kind} channel ${input.name} (draft)`,
        after: { ...input, status: 'DRAFT', secrets: Object.keys(input.secrets) },
      });
      return inserted;
    });
    return (await this.views([row!]))[0]!;
  }

  /**
   * Name, settings and secrets of a DRAFT channel (never approved), written directly. Once the channel has
   * been approved this answers 409 approval_required: the change is an UPDATE proposal (stageChange). The
   * status is not changed here — disable() stops it, and activation is always a proposal.
   */
  async update(actor: ActorContext, id: string, patch: ChannelEdit): Promise<ChannelView> {
    assertCan(actor.principal!, Permission.CHANNELS_MANAGE);
    const [existing] = await this.db.select().from(channels).where(eq(channels.id, id));
    if (!existing) throw notFound('channel', id);
    const merged = { ...(await this.resolveSecrets(existing)), ...(patch.secrets ?? {}) };
    const settings = patch.settings ?? existing.settings;
    const problems = draftProblems(this.validate(existing.kind, settings, merged), settings, merged, existing.status === 'DRAFT');
    if (problems.length) throw validation('invalid_channel_config', problems.join('; '));
    const newRefs = patch.secrets ? await this.storeSecrets(patch.name ?? existing.name, patch.secrets) : {};
    let before: typeof existing;
    let row: typeof existing;
    try {
      [before, row] = await this.db.transaction(async (tx) => {
        await assertPlatformWrite(tx, 'channel', id);
        const [locked] = await tx.select().from(channels).where(eq(channels.id, id)).for('update');
        const [updated] = await tx
          .update(channels)
          .set({
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.settings !== undefined ? { settings: patch.settings } : {}),
            secretRefs: { ...locked!.secretRefs, ...newRefs },
            updatedAt: new Date(),
          })
          .where(eq(channels.id, id))
          .returning();
        await recordAudit(tx, actor, {
          action: 'channel.update',
          redaction: 'settings',
          targetType: 'channel',
          targetId: id,
          summary: `Updated channel ${locked!.name}`,
          before: { ...locked!, secretRefs: Object.keys(locked!.secretRefs) },
          after: { ...patch, secrets: patch.secrets ? Object.keys(patch.secrets) : undefined },
        });
        await bumpGeneration(tx, actor.correlationId, `channel:${id}`, 'channel_behavior_changed');
        return [locked!, updated!] as const;
      });
    } catch (err) {
      await discardSecrets(this.secrets, Object.values(newRefs));
      throw err;
    }
    // Replaced secrets are deleted only after the new refs are committed.
    for (const [key, ref] of Object.entries(before.secretRefs)) {
      if (newRefs[key] && newRefs[key] !== ref) await this.secrets.delete(ref).catch(() => {});
    }
    return (await this.views([row]))[0]!;
  }

  /** Stop action: immediate, never gated, allowed while a proposal is open. Resuming is an ACTIVATE proposal. */
  async disable(actor: ActorContext, id: string): Promise<ChannelView> {
    assertCan(actor.principal!, Permission.CHANNELS_MANAGE);
    const row = await this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(channels).where(eq(channels.id, id)).for('update');
      if (!locked) throw notFound('channel', id);
      if (locked.status === 'DISABLED') return locked;
      const [updated] = await tx.update(channels).set({ status: 'DISABLED', updatedAt: new Date() }).where(eq(channels.id, id)).returning();
      await recordAudit(tx, actor, { action: 'channel.disable', targetType: 'channel', targetId: id, summary: `Disabled channel ${locked.name}`, before: { status: locked.status }, after: { status: 'DISABLED' } });
      await bumpGeneration(tx, actor.correlationId, `channel:${id}`, 'channel_behavior_changed');
      return updated!;
    });
    return (await this.views([row]))[0]!;
  }

  /**
   * The payload of an UPDATE proposal: new secret values stored as NEW secrets (the live channel keeps its
   * values until approval) and carried as refs only. `discard` removes them if the submit fails.
   */
  async stageChange(actor: ActorContext, id: string, patch: ChannelEdit): Promise<{ payload: ChannelChange; discard: () => Promise<void> }> {
    const [row] = await this.db.select().from(channels).where(eq(channels.id, id));
    if (!row) throw notFound('channel', id);
    const merged = { ...(await this.resolveSecrets(row)), ...(patch.secrets ?? {}) };
    const problems = this.validate(row.kind, patch.settings ?? row.settings, merged);
    if (problems.length) throw validation('invalid_channel_config', problems.join('; '));
    const owner = { kind: 'channel', objectId: row.id, makerId: actor.principal!.userId };
    const credentials = patch.secrets ? await stageSecrets(this.db, this.secrets, owner, { name: `${patch.name ?? row.name}`, kind: () => 'CHANNEL_TOKEN', usedBy: `channel:${row.name}` }, patch.secrets) : undefined;
    const payload: ChannelChange = {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.settings !== undefined ? { settings: patch.settings } : {}),
      ...(credentials?.length ? { credentials } : {}),
    };
    return { payload, discard: () => unstageSecrets(this.db, this.secrets, (credentials ?? []).map((c) => c.ref)) };
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

