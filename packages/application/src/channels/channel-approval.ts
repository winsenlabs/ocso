import { count, eq } from 'drizzle-orm';
import { Permission } from '@ocso/auth';
import { channels, conversations, webchatUserTokens, type DbOrTx } from '@ocso/db';
import type { SecretStore } from '@ocso/secrets';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { bumpGeneration } from '../cache/generations.js';
import type { ApprovalDescriptor, ApprovalProblem, ProposalRow } from '../approvals/contract.js';
import { credentialView, platformRequiresApproval, platformTitle, platformVisible, StoredCredentials, type StoredCredential } from '../settings/platform-approvals.js';
import { claimSecrets, releaseSecrets, unstagedRefProblems } from '../settings/secret-refs.js';
import type { ChannelConfigValidator } from './channels.js';

/**
 * Channels under maker–checker (PM/research/11 §4, checked with approvals.check.channels):
 * - a channel is created as a DRAFT: inert (ingress refuses non-ACTIVE channels), freely editable;
 * - ACTIVATE takes it ACTIVE — the first time, and when resuming a DISABLED channel;
 * - UPDATE: a change to an approved channel's name, settings or credentials. New credential values are stored
 *   as new secrets when the proposal is submitted; the payload carries only their refs;
 * - DELETE: always a proposal; refused while the channel is ACTIVE or has conversations on record.
 * Disabling is a stop action (immediate, never gated) and is left out of the content hash.
 */

export const ChannelChange = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    /** New credential values as secret refs created at submit; replaced ones are deleted after approval. */
    credentials: StoredCredentials.optional(),
  })
  .strict();
export type ChannelChange = z.infer<typeof ChannelChange>;

export interface ChannelApprovalDeps {
  /** Resolves stored credentials so activation can validate the configuration. */
  secrets?: SecretStore | undefined;
  /** The channel registry's settings/secrets validation. */
  validateChannel?: ChannelConfigValidator | undefined;
}

type ChannelRow = typeof channels.$inferSelect;

async function load(tx: DbOrTx, id: string): Promise<ChannelRow | null> {
  const [row] = await tx.select().from(channels).where(eq(channels.id, id));
  return row ?? null;
}

function projectRow(row: ChannelRow, change?: ChannelChange): Record<string, unknown> {
  const replaced = change?.credentials?.map((c) => c.field) ?? [];
  return {
    name: change?.name ?? row.name,
    kind: row.kind,
    status: row.status,
    settings: change?.settings ?? row.settings,
    credentials: credentialView(Object.keys(row.secretRefs), { replaced }),
    publicKey: row.publicKey,
  };
}

/** The refs a channel will hold once the change applies. */
export function mergedChannelRefs(current: Readonly<Record<string, string>>, credentials: readonly StoredCredential[] | undefined): Record<string, string> {
  return { ...current, ...Object.fromEntries((credentials ?? []).map((c) => [c.field, c.ref])) };
}

async function configProblems(deps: ChannelApprovalDeps, kind: string, settings: unknown, refs: Record<string, string>): Promise<ApprovalProblem[]> {
  if (!deps.secrets || !deps.validateChannel) return [{ code: 'channel_validation_unavailable', message: 'Channel configuration cannot be checked in this process.' }];
  const values: Record<string, string> = {};
  try {
    for (const [key, ref] of Object.entries(refs)) values[key] = await deps.secrets.resolve(ref);
  } catch {
    return [{ code: 'channel_credentials_missing', message: 'A stored channel credential could not be read.' }];
  }
  return deps.validateChannel(kind, settings, values).map((message) => ({ code: 'invalid_channel_config', message }));
}

export function channelApproval(deps: ChannelApprovalDeps = {}): ApprovalDescriptor {
  return {
    kind: 'channel',
    label: 'Channel',
    actions: ['ACTIVATE', 'UPDATE', 'DELETE'],
    makePermission: () => Permission.CHANNELS_MANAGE,
    checkPermission: Permission.APPROVALS_CHECK_CHANNELS,
    // A sole Tech (no one anywhere holds check.channels) may still take a channel live, recorded as a bootstrap.
    bootstrapPermission: Permission.APPROVALS_CHECK_PLATFORM,
    payload: ChannelChange,
    // Disabling is a stop action: it must not void an open proposal. Activation re-validates the status.
    hashExclude: ['status'],

    async project(tx, id) {
      const row = await load(tx, id);
      return row ? projectRow(row) : null;
    },
    async projectAfter(tx, p) {
      const row = await load(tx, p.objectId);
      if (!row || p.action === 'DELETE') return null;
      if (p.action === 'ACTIVATE') return { ...projectRow(row), status: 'ACTIVE' };
      return projectRow(row, p.payload as ChannelChange);
    },
    teamIds: async () => [],
    dependencies: async () => [],
    assertVisible: platformVisible(Permission.CHANNELS_READ),
    requiresApproval: platformRequiresApproval('channel'),
    async validate(tx, p) {
      const row = await load(tx, p.objectId);
      if (!row) return [{ code: 'object_missing', message: 'The channel no longer exists.' }];
      if (p.action === 'DELETE') return deleteProblems(tx, row);
      if (p.action === 'ACTIVATE') {
        if (row.status === 'ACTIVE') return [{ code: 'already_active', message: 'The channel is already active.' }];
        return configProblems(deps, row.kind, row.settings, row.secretRefs);
      }
      const change = p.payload as ChannelChange;
      const refs = await unstagedRefProblems(tx, p, (change.credentials ?? []).map((c) => c.ref));
      if (refs.length) return refs;
      // A draft or disabled channel is validated when it is activated; an active one must stay valid.
      if (row.status !== 'ACTIVE') return [];
      return configProblems(deps, row.kind, change.settings ?? row.settings, mergedChannelRefs(row.secretRefs, change.credentials));
    },
    async activate(tx, actor, p) {
      const row = (await load(tx, p.objectId))!;
      if (p.action === 'ACTIVATE') {
        await tx.update(channels).set({ status: 'ACTIVE', updatedAt: new Date() }).where(eq(channels.id, row.id));
        await recordAudit(tx, actor, {
          action: 'channel.activate',
          targetType: 'channel',
          targetId: row.id,
          summary: `${row.status === 'DISABLED' ? 'Re-enabled' : 'Activated'} channel ${row.name}`,
          before: { status: row.status },
          after: { status: 'ACTIVE' },
        });
      } else if (p.action === 'UPDATE') {
        const change = p.payload as ChannelChange;
        const refs = mergedChannelRefs(row.secretRefs, change.credentials);
        await tx
          .update(channels)
          .set({ ...(change.name !== undefined ? { name: change.name } : {}), ...(change.settings !== undefined ? { settings: change.settings } : {}), secretRefs: refs, updatedAt: new Date() })
          .where(eq(channels.id, row.id));
        await recordAudit(tx, actor, {
          action: 'channel.update',
          redaction: 'settings',
          targetType: 'channel',
          targetId: row.id,
          summary: `Updated channel ${row.name}${change.credentials?.length ? ` (credentials replaced: ${change.credentials.map((c) => c.field).join(', ')})` : ''}`,
          before: { name: row.name, settings: row.settings, credentials: Object.keys(row.secretRefs) },
          after: { name: change.name, settings: change.settings, credentialsReplaced: change.credentials?.map((c) => c.field) },
        });
        // Held end-user tokens were kept under the old settings (tool identity, verification, secret key): drop them,
        // so nothing is forwarded under a policy that no longer allows it. Visitors re-verify on their next session.
        await tx.delete(webchatUserTokens).where(eq(webchatUserTokens.channelId, row.id));
        // The staged values are the channel's now; the replaced ones are deleted once this commits.
        await claimSecrets(tx, (change.credentials ?? []).map((c) => c.ref));
        await releaseSecrets(tx, { kind: 'channel', objectId: row.id }, (change.credentials ?? []).map((c) => (row.secretRefs[c.field] !== c.ref ? row.secretRefs[c.field] : null)));
      } else {
        await tx.delete(channels).where(eq(channels.id, row.id));
        await recordAudit(tx, actor, {
          action: 'channel.delete',
          targetType: 'channel',
          targetId: row.id,
          summary: `Deleted ${row.kind} channel ${row.name}`,
          before: { name: row.name, kind: row.kind, status: row.status, settings: row.settings, credentials: Object.keys(row.secretRefs) },
        });
        await releaseSecrets(tx, { kind: 'channel', objectId: row.id }, Object.values(row.secretRefs));
      }
      await bumpGeneration(tx, actor.correlationId, `channel:${row.id}`, 'channel_behavior_changed');
      return { kind: 'DONE' };
    },
    async liveObjects(tx) {
      return (await tx.select({ id: channels.id }).from(channels).where(eq(channels.status, 'ACTIVE'))).map((r) => r.id);
    },
    title: (p: ProposalRow, before) => platformTitle(p, before, { noun: 'channel', resumed: before?.['status'] === 'DISABLED' }),
  };
}

async function deleteProblems(tx: DbOrTx, row: ChannelRow): Promise<ApprovalProblem[]> {
  const problems: ApprovalProblem[] = [];
  if (row.status === 'ACTIVE') problems.push({ code: 'channel_active', message: 'Disable the channel before deleting it.' });
  const [history] = await tx.select({ n: count() }).from(conversations).where(eq(conversations.channelId, row.id));
  if ((history?.n ?? 0) > 0) problems.push({ code: 'channel_has_history', message: `The channel has ${history!.n} conversation(s) on record; disable it instead so the history stays attributable.` });
  return problems;
}
