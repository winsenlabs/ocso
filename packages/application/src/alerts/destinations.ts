import { asc, eq, sql } from 'drizzle-orm';
import { DESTINATION_KINDS, secretRequirement, type AlertDeliveryAdapter, type AlertDeliveryRegistry, type AlertMessage, type DeliveryResult } from '@ocso/alerts';
import { Permission, can } from '@ocso/auth';
import { alertRules, notificationDestinations, uuidv7, type Db, type DbOrTx } from '@ocso/db';
import { forbidden, notFound, validation } from '@ocso/domain';
import type { SecretStore } from '@ocso/secrets';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { requirePrincipal } from './audience.js';
import { deploymentLabel } from './message.js';
import { toDestinationView, type NotificationDestinationRow, type NotificationDestinationView } from './views.js';

export const DestinationInput = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(DESTINATION_KINDS),
  config: z.record(z.string(), z.unknown()).default({}),
  /** Plaintext secret entered once (webhook URL, routing key, SMTP password); stored in the SecretStore, never returned. */
  secret: z.string().min(1).max(4096).optional(),
  enabled: z.boolean().default(true),
});
export type DestinationInput = z.infer<typeof DestinationInput>;

export const DestinationPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secret: z.string().min(1).max(4096).optional(),
  enabled: z.boolean().optional(),
});
export type DestinationPatch = z.infer<typeof DestinationPatch>;

export interface DestinationServiceOptions {
  baseUrl?: string | null | undefined;
  now?: (() => Date) | undefined;
}

/** Pluggable alert delivery targets (docs/11 §7). Secrets live only in the SecretStore. */
export class NotificationDestinationService {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
    private readonly registry: AlertDeliveryRegistry,
    private readonly options: DestinationServiceOptions = {},
  ) {}

  /** Rule editors may list destinations to attach them; only managers see configuration. */
  async list(actor: ActorContext): Promise<NotificationDestinationView[]> {
    const principal = requirePrincipal(actor, 'notification_destinations.read');
    const manager = can(principal, Permission.NOTIFICATION_DESTINATIONS_MANAGE);
    const editor = can(principal, Permission.ALERT_RULES_TECHNICAL_MANAGE) || can(principal, Permission.ALERT_RULES_BUSINESS_MANAGE);
    if (!manager && !editor) throw forbidden(Permission.NOTIFICATION_DESTINATIONS_MANAGE);
    const rows = await this.db.select().from(notificationDestinations).orderBy(asc(notificationDestinations.name));
    return rows.map((r) => toDestinationView(r, manager));
  }

  async get(actor: ActorContext, id: string): Promise<NotificationDestinationView> {
    this.assertManage(actor);
    return toDestinationView(await this.load(this.db, id), true);
  }

  async create(actor: ActorContext, input: DestinationInput): Promise<NotificationDestinationView> {
    this.assertManage(actor);
    const adapter = this.adapter(input.kind);
    const config = checkConfig(adapter, input.config);
    const secret = checkSecret(adapter, config, input.secret ?? null);
    const id = uuidv7();
    const secretRef = secret ? await this.storeSecret(adapter, input.name, secret) : null;
    try {
      const [row] = await this.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(notificationDestinations)
          .values({ id, name: input.name, kind: input.kind, config, secretRef, enabled: input.enabled })
          .returning();
        await recordAudit(tx, actor, {
          action: 'notification_destination.create',
          targetType: 'notification_destination',
          targetId: id,
          summary: `Created ${adapter.label} destination "${input.name}"`,
          after: { name: input.name, kind: input.kind, config, hasSecret: Boolean(secretRef), enabled: input.enabled },
        });
        await emitEvent(tx, actor, 'config.changed', { area: 'notification_destinations', entityId: id });
        return inserted;
      });
      return toDestinationView(row!, true);
    } catch (error) {
      // Never leave an orphaned secret behind a failed insert.
      if (secretRef) await this.secrets.delete(secretRef).catch(() => undefined);
      throw error;
    }
  }

  async update(actor: ActorContext, id: string, patch: DestinationPatch): Promise<NotificationDestinationView> {
    this.assertManage(actor);
    const before = await this.load(this.db, id);
    const adapter = this.adapter(before.kind);
    const config = patch.config !== undefined ? checkConfig(adapter, patch.config) : before.config;
    const secret = patch.secret !== undefined ? checkSecret(adapter, config, patch.secret) : null;
    // A config that no longer takes a secret (e.g. email switched to the deployment sender) drops the stored one.
    const dropRef = before.secretRef && !requirementFor(adapter, config) ? before.secretRef : null;
    const newRef = secret && !before.secretRef ? await this.storeSecret(adapter, patch.name ?? before.name, secret) : null;
    if (secret && before.secretRef) await this.secrets.rotate(before.secretRef, secret);
    const [row] = await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(notificationDestinations)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(newRef ? { secretRef: newRef } : {}),
          ...(dropRef ? { secretRef: null } : {}),
          config,
          updatedAt: new Date(),
        })
        .where(eq(notificationDestinations.id, id))
        .returning();
      await recordAudit(tx, actor, {
        action: 'notification_destination.update',
        targetType: 'notification_destination',
        targetId: id,
        summary: `Updated destination "${before.name}"${secret ? ' (secret replaced)' : ''}${dropRef ? ' (stored secret removed)' : ''}`,
        before: { name: before.name, config: before.config, enabled: before.enabled },
        after: { name: patch.name, config: patch.config, enabled: patch.enabled, secretReplaced: Boolean(secret) },
      });
      await emitEvent(tx, actor, 'config.changed', { area: 'notification_destinations', entityId: id });
      return updated;
    });
    if (dropRef) await this.secrets.delete(dropRef).catch(() => undefined);
    return toDestinationView(row!, true);
  }

  /** Removes the destination from every rule, then deletes its secret after commit. */
  async delete(actor: ActorContext, id: string): Promise<void> {
    this.assertManage(actor);
    const before = await this.load(this.db, id);
    await this.db.transaction(async (tx) => {
      await tx
        .update(alertRules)
        .set({ destinationIds: sql`array_remove(${alertRules.destinationIds}, ${id}::uuid)` })
        .where(sql`${alertRules.destinationIds} @> ARRAY[${id}]::uuid[]`);
      await tx.delete(notificationDestinations).where(eq(notificationDestinations.id, id));
      await recordAudit(tx, actor, {
        action: 'notification_destination.delete',
        targetType: 'notification_destination',
        targetId: id,
        summary: `Deleted destination "${before.name}"`,
        before: { name: before.name, kind: before.kind, config: before.config },
      });
      await emitEvent(tx, actor, 'config.changed', { area: 'notification_destinations', entityId: id });
    });
    if (before.secretRef) await this.secrets.delete(before.secretRef).catch(() => undefined);
  }

  /** Send a synthetic alert through the destination now (no alert row, no queue). */
  async test(actor: ActorContext, id: string): Promise<DeliveryResult> {
    this.assertManage(actor);
    const row = await this.load(this.db, id);
    const adapter = this.adapter(row.kind);
    const check = adapter.validateConfig(row.config);
    if (!check.ok) return { ok: false, retriable: false, error: `invalid configuration: ${check.problems.join('; ')}` };
    const secret = row.secretRef && requirementFor(adapter, check.config) ? await this.secrets.resolve(row.secretRef) : null;
    const result = await adapter.deliver(await this.testMessage(row), check.config, secret).catch(() => ({ ok: false, retriable: true, error: 'adapter error' }));
    await recordAudit(this.db, actor, {
      action: 'notification_destination.test',
      targetType: 'notification_destination',
      targetId: id,
      summary: `Test alert to "${row.name}": ${result.ok ? 'delivered' : `failed (${result.error ?? 'unknown'})`}`,
    });
    return { ok: result.ok, retriable: result.retriable, ...(result.error ? { error: result.error } : {}) };
  }

  private async testMessage(row: NotificationDestinationRow): Promise<AlertMessage> {
    const now = (this.options.now?.() ?? new Date()).toISOString();
    return {
      alertId: `test-${row.id}`,
      deliveryId: uuidv7(),
      event: 'OPENED',
      fingerprint: `test:${row.id}`,
      ruleId: null,
      ruleName: null,
      condition: null,
      kind: 'TECHNICAL',
      severity: 'INFO',
      status: 'OPEN',
      title: 'Test alert from OCSO',
      body: `This is a test notification for destination "${row.name}". No action is needed.`,
      value: null,
      source: 'OCSO',
      context: { test: true },
      occurrences: 1,
      openedAt: now,
      lastSeenAt: now,
      acknowledgedAt: null,
      resolvedAt: null,
      resolution: null,
      link: this.options.baseUrl ?? null,
      deployment: await deploymentLabel(this.db),
    };
  }

  private assertManage(actor: ActorContext): void {
    const principal = requirePrincipal(actor, Permission.NOTIFICATION_DESTINATIONS_MANAGE);
    if (!can(principal, Permission.NOTIFICATION_DESTINATIONS_MANAGE)) throw forbidden(Permission.NOTIFICATION_DESTINATIONS_MANAGE, `role ${principal.role} cannot manage notification destinations`);
  }

  private adapter(kind: string): AlertDeliveryAdapter {
    const adapter = this.registry.find(kind);
    if (!adapter) throw validation('unsupported_destination_kind', `No delivery adapter for ${kind}`);
    return adapter;
  }

  private async load(db: DbOrTx, id: string): Promise<NotificationDestinationRow> {
    const [row] = await db.select().from(notificationDestinations).where(eq(notificationDestinations.id, id));
    if (!row) throw notFound('notification_destination', id);
    return row;
  }

  private async storeSecret(adapter: AlertDeliveryAdapter, name: string, value: string): Promise<string> {
    const meta = await this.secrets.put({
      name: `alert destination ${name}`,
      kind: adapter.secret?.secretKind ?? 'OTHER',
      value,
      usedBy: `notification_destination:${name}`,
    });
    return meta.ref;
  }
}

function checkConfig(adapter: AlertDeliveryAdapter, config: unknown): Record<string, unknown> {
  const check = adapter.validateConfig(config);
  if (!check.ok) throw validation('invalid_destination_config', check.problems.join('; '), { problems: check.problems });
  return check.config as Record<string, unknown>;
}

/** Secret requirement for a stored or submitted config (validated first: legacy rows lack defaults). */
function requirementFor(adapter: AlertDeliveryAdapter, config: unknown) {
  const check = adapter.validateConfig(config);
  return check.ok ? secretRequirement(adapter, check.config) : adapter.secret;
}

function checkSecret(adapter: AlertDeliveryAdapter, config: unknown, secret: string | null): string | null {
  const requirement = requirementFor(adapter, config);
  if (!requirement) {
    if (secret) throw validation('secret_not_supported', `${adapter.label} destinations${adapter.secretFor ? ' with this configuration' : ''} do not take a secret`);
    return null;
  }
  if (!secret) {
    if (requirement.required) throw validation('secret_required', `${adapter.label} requires: ${requirement.description}`);
    return null;
  }
  // Problems describe the value's shape only; the value itself is never echoed.
  const problems = adapter.validateSecret(secret);
  if (problems.length) throw validation('invalid_destination_secret', problems.join('; '));
  return secret;
}
