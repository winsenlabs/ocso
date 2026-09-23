import { eq, sql } from 'drizzle-orm';
import { secretRequirement, type AlertDeliveryRegistry } from '@ocso/alerts';
import { Permission } from '@ocso/auth';
import { alertRules, notificationDestinations, type DbOrTx } from '@ocso/db';
import type { SecretStore } from '@ocso/secrets';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import type { ApprovalDescriptor, ApprovalProblem, ProposalRow } from '../approvals/contract.js';
import { platformRequiresApproval, platformTitle, platformVisible } from '../settings/platform-approvals.js';
import { claimSecrets, releaseSecrets, unstagedRefProblems } from '../settings/secret-refs.js';
import type { NotificationDestinationRow } from './views.js';

/**
 * Notification destinations under maker–checker (PM/research/11 §4, approvals.check.platform). A destination
 * is created disabled — a draft that alert dispatch never delivers to. Enabling is ACTIVATE (first time and
 * resume); disabling is a stop action. Once approved, a change is an UPDATE proposal: a new secret (webhook
 * URL, routing key, SMTP password) is stored as a new secret at submit and only its ref travels. DELETE is
 * always a proposal; it also detaches the destination from every rule.
 */

export const DestinationChange = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    /** A new secret value stored at submit (its ref only). */
    credentialRef: z.string().min(1).max(300).optional(),
  })
  .strict();
export type DestinationChange = z.infer<typeof DestinationChange>;

export interface DestinationApprovalDeps {
  secrets?: SecretStore | undefined;
  deliveries?: AlertDeliveryRegistry | undefined;
}

async function load(tx: DbOrTx, id: string): Promise<NotificationDestinationRow | null> {
  const [row] = await tx.select().from(notificationDestinations).where(eq(notificationDestinations.id, id));
  return row ?? null;
}

async function attachedRules(tx: DbOrTx, id: string): Promise<string[]> {
  const rows = await tx.select({ name: alertRules.name }).from(alertRules).where(sql`${alertRules.destinationIds} @> ARRAY[${id}]::uuid[]`);
  return rows.map((r) => r.name).sort();
}

/** Does the (validated) config take a secret? Unknown kinds keep what they have. */
function takesSecret(deps: DestinationApprovalDeps, kind: string, config: unknown): boolean | null {
  const adapter = deps.deliveries?.find(kind);
  if (!adapter) return null;
  const check = adapter.validateConfig(config);
  return Boolean(check.ok ? secretRequirement(adapter, check.config) : adapter.secret);
}

async function projectRow(tx: DbOrTx, deps: DestinationApprovalDeps, row: NotificationDestinationRow, change?: DestinationChange): Promise<Record<string, unknown>> {
  const config = change?.config ?? row.config;
  const secret = takesSecret(deps, row.kind, config);
  return {
    name: change?.name ?? row.name,
    kind: row.kind,
    config,
    enabled: row.enabled,
    secret: change?.credentialRef ? 'new value (proposed)' : secret === false ? 'none' : row.secretRef ? 'stored' : 'none',
    rules: await attachedRules(tx, row.id),
  };
}

export function destinationApproval(deps: DestinationApprovalDeps = {}): ApprovalDescriptor {
  return {
    kind: 'notification_destination',
    label: 'Notification destination',
    actions: ['ACTIVATE', 'UPDATE', 'DELETE'],
    makePermission: () => Permission.NOTIFICATION_DESTINATIONS_MANAGE,
    checkPermission: Permission.APPROVALS_CHECK_PLATFORM,
    payload: DestinationChange,
    // Disabling is a stop action; attaching it to a rule is the rule's own change.
    hashExclude: ['enabled', 'rules'],

    async project(tx, id) {
      const row = await load(tx, id);
      return row ? projectRow(tx, deps, row) : null;
    },
    async projectAfter(tx, p) {
      const row = await load(tx, p.objectId);
      if (!row || p.action === 'DELETE') return null;
      if (p.action === 'ACTIVATE') return { ...(await projectRow(tx, deps, row)), enabled: true };
      return projectRow(tx, deps, row, p.payload as DestinationChange);
    },
    teamIds: async () => [],
    dependencies: async () => [],
    assertVisible: platformVisible(Permission.NOTIFICATION_DESTINATIONS_MANAGE),
    requiresApproval: platformRequiresApproval('notification_destination'),
    async validate(tx, p) {
      const row = await load(tx, p.objectId);
      if (!row) return [{ code: 'object_missing', message: 'The destination no longer exists.' }];
      if (p.action === 'DELETE') return [];
      if (p.action === 'ACTIVATE' && row.enabled) return [{ code: 'already_enabled', message: 'The destination is already enabled.' }];
      const change = p.action === 'UPDATE' ? (p.payload as DestinationChange) : {};
      const unstaged = await unstagedRefProblems(tx, p, [change.credentialRef]);
      if (unstaged.length) return unstaged;
      const adapter = deps.deliveries?.find(row.kind);
      if (!adapter) return [{ code: 'unsupported_destination_kind', message: `No delivery adapter for ${row.kind} in this process.` }];
      const check = adapter.validateConfig(change.config ?? row.config);
      if (!check.ok) return check.problems.map((message): ApprovalProblem => ({ code: 'invalid_destination_config', message }));
      const requirement = secretRequirement(adapter, check.config);
      if (requirement?.required && !change.credentialRef && !row.secretRef) return [{ code: 'secret_required', message: `${adapter.label} requires: ${requirement.description}` }];
      if (!requirement && change.credentialRef) return [{ code: 'secret_not_supported', message: `${adapter.label} destinations with this configuration do not take a secret.` }];
      return [];
    },
    async activate(tx, actor, p) {
      const row = (await load(tx, p.objectId))!;
      if (p.action === 'DELETE') {
        await tx
          .update(alertRules)
          .set({ destinationIds: sql`array_remove(${alertRules.destinationIds}, ${row.id}::uuid)` })
          .where(sql`${alertRules.destinationIds} @> ARRAY[${row.id}]::uuid[]`);
        await tx.delete(notificationDestinations).where(eq(notificationDestinations.id, row.id));
        await recordAudit(tx, actor, { action: 'notification_destination.delete', targetType: 'notification_destination', targetId: row.id, summary: `Deleted destination "${row.name}"`, before: { name: row.name, kind: row.kind, config: row.config } });
        await releaseSecrets(tx, { kind: 'notification_destination', objectId: row.id }, [row.secretRef]);
      } else if (p.action === 'ACTIVATE') {
        await tx.update(notificationDestinations).set({ enabled: true, updatedAt: new Date() }).where(eq(notificationDestinations.id, row.id));
        await recordAudit(tx, actor, { action: 'notification_destination.enable', targetType: 'notification_destination', targetId: row.id, summary: `Enabled destination "${row.name}"`, before: { enabled: false }, after: { enabled: true } });
      } else {
        const change = p.payload as DestinationChange;
        const adapter = deps.deliveries?.find(row.kind);
        const check = change.config !== undefined && adapter ? adapter.validateConfig(change.config) : null;
        const config = check?.ok ? (check.config as Record<string, unknown>) : (change.config ?? row.config);
        // A config that no longer takes a secret drops the stored one.
        const keep = takesSecret(deps, row.kind, config) !== false;
        const secretRef = change.credentialRef ?? (keep ? row.secretRef : null);
        await tx
          .update(notificationDestinations)
          .set({ ...(change.name !== undefined ? { name: change.name } : {}), config, secretRef, updatedAt: new Date() })
          .where(eq(notificationDestinations.id, row.id));
        await recordAudit(tx, actor, {
          action: 'notification_destination.update',
          targetType: 'notification_destination',
          targetId: row.id,
          summary: `Updated destination "${row.name}"${change.credentialRef ? ' (secret replaced)' : ''}${row.secretRef && !secretRef ? ' (stored secret removed)' : ''}`,
          before: { name: row.name, config: row.config, enabled: row.enabled },
          after: { name: change.name, config: change.config, secretReplaced: Boolean(change.credentialRef) },
        });
        await claimSecrets(tx, [change.credentialRef]);
        if (row.secretRef && row.secretRef !== secretRef) await releaseSecrets(tx, { kind: 'notification_destination', objectId: row.id }, [row.secretRef]);
      }
      await emitEvent(tx, actor, 'config.changed', { area: 'notification_destinations', entityId: row.id });
      return { kind: 'DONE' };
    },
    async liveObjects(tx) {
      return (await tx.select({ id: notificationDestinations.id }).from(notificationDestinations).where(eq(notificationDestinations.enabled, true))).map((r) => r.id);
    },
    title: (p: ProposalRow, before) => platformTitle(p, before, { noun: 'destination', activateVerb: 'Enable' }),
  };
}
