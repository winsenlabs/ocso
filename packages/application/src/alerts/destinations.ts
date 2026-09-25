import { asc, eq, sql } from 'drizzle-orm';
import { secretRequirement, type AlertDeliveryAdapter, type AlertDeliveryRegistry, type AlertMessage, type DeliveryResult, type DestinationKindInfo } from '@ocso/alerts';
import { Permission, can } from '@ocso/auth';
import { alertRules, notificationDestinations, uuidv7, type Db, type DbOrTx } from '@ocso/db';
import { forbidden, notFound, validation } from '@ocso/domain';
import type { SecretStore } from '@ocso/secrets';
import { z } from 'zod';
import { approvalRequiredError } from '../approvals/guard.js';
import { recordAudit } from '../audit/audit.js';
import { assertPlatformWrite } from '../settings/platform-approvals.js';
import { stageSecrets, unstageSecrets } from '../settings/secret-refs.js';
import type { DestinationChange } from './destination-approval.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { requirePrincipal } from './audience.js';
import { deploymentLabel } from './message.js';
import { toDestinationView, type NotificationDestinationRow, type NotificationDestinationView } from './views.js';

export const DestinationInput = z.object({
  name: z.string().trim().min(1).max(120),
  /** A registered delivery adapter's kind; the registry validates it (kinds are open). */
  kind: z.string().trim().min(1).max(40),
  config: z.record(z.string(), z.unknown()).default({}),
  /** Plaintext secret entered once (webhook URL, routing key, SMTP password); stored in the SecretStore, never returned. */
  secret: z.string().min(1).max(4096).optional(),
  /** true asks for activation at once (a proposal: the API needs `approval`); a new destination is a disabled draft. */
  enabled: z.boolean().default(false),
});
export type DestinationInput = z.infer<typeof DestinationInput>;

export const DestinationPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secret: z.string().min(1).max(4096).optional(),
  enabled: z.boolean().optional(),
});
export type DestinationPatch = z.infer<typeof DestinationPatch>;
/** What a person edits (`enabled` moves through disable() and ACTIVATE proposals). */
export type DestinationEdit = Omit<DestinationPatch, 'enabled'>;

export interface DestinationServiceOptions {
  baseUrl?: string | null | undefined;
  now?: (() => Date) | undefined;
}

/**
 * Pluggable alert delivery targets (docs/archive/specs/11 §7). Secrets live only in the SecretStore.
 * Maker–checker (PM/research/11 §4, destination-approval.ts): a new destination is a disabled draft.
 */
export class NotificationDestinationService {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
    private readonly registry: AlertDeliveryRegistry,
    private readonly options: DestinationServiceOptions = {},
  ) {}

  /** Rule editors may list destinations to attach them; only managers see configuration. */
  async list(actor: ActorContext): Promise<NotificationDestinationView[]> {
    const manager = this.assertRead(actor);
    const rows = await this.db.select().from(notificationDestinations).orderBy(asc(notificationDestinations.name));
    return rows.map((r) => this.view(r, manager));
  }

  /** Registered destination kinds with their form (JSON Schema), secret field and events — for the web form. */
  kinds(actor: ActorContext): DestinationKindInfo[] {
    this.assertRead(actor);
    return this.registry.describe();
  }

  async get(actor: ActorContext, id: string): Promise<NotificationDestinationView> {
    this.assertManage(actor);
    return this.view(await this.load(this.db, id), true);
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
          // A draft: alert dispatch skips it until its ACTIVATE proposal is approved (destination-approval.ts).
          .values({ id, name: input.name, kind: input.kind, config, secretRef, enabled: false })
          .returning();
        await recordAudit(tx, actor, {
          action: 'notification_destination.create',
          targetType: 'notification_destination',
          targetId: id,
          summary: `Created ${adapter.label} destination "${input.name}"`,
          after: { name: input.name, kind: input.kind, config, hasSecret: Boolean(secretRef), enabled: false },
        });
        await emitEvent(tx, actor, 'config.changed', { area: 'notification_destinations', entityId: id });
        return inserted;
      });
      return this.view(row!, true);
    } catch (error) {
      // Never leave an orphaned secret behind a failed insert.
      if (secretRef) await this.secrets.delete(secretRef).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Name, configuration and secret of a DRAFT destination, written directly. Once approved this answers
   * 409 approval_required (the change is an UPDATE proposal, stageChange). `enabled` is not changed here:
   * disable() stops it; enabling is always an ACTIVATE proposal.
   */
  async update(actor: ActorContext, id: string, patch: DestinationEdit): Promise<NotificationDestinationView> {
    this.assertManage(actor);
    const before = await this.load(this.db, id);
    await this.db.transaction((tx) => assertPlatformWrite(tx, 'notification_destination', id));
    const adapter = this.adapter(before.kind);
    const config = patch.config !== undefined ? checkConfig(adapter, patch.config) : before.config;
    const secret = patch.secret !== undefined ? checkSecret(adapter, config, patch.secret) : null;
    // A config that no longer takes a secret (e.g. email switched to the deployment sender) drops the stored one.
    const dropRef = before.secretRef && !requirementFor(adapter, config) ? before.secretRef : null;
    const newRef = secret ? await this.storeSecret(adapter, patch.name ?? before.name, secret) : null;
    let row: NotificationDestinationRow;
    try {
      [row] = (await this.db.transaction(async (tx) => {
        await assertPlatformWrite(tx, 'notification_destination', id);
        const updated = await tx
          .update(notificationDestinations)
          .set({
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(newRef ? { secretRef: newRef } : dropRef ? { secretRef: null } : {}),
            config,
            updatedAt: new Date(),
          })
          .where(eq(notificationDestinations.id, id))
          .returning();
        await recordAudit(tx, actor, {
          action: 'notification_destination.update',
          targetType: 'notification_destination',
          targetId: id,
          summary: `Updated destination "${before.name}"${secret ? ' (secret replaced)' : ''}${dropRef && !newRef ? ' (stored secret removed)' : ''}`,
          before: { name: before.name, config: before.config, enabled: before.enabled },
          after: { name: patch.name, config: patch.config, secretReplaced: Boolean(secret) },
        });
        await emitEvent(tx, actor, 'config.changed', { area: 'notification_destinations', entityId: id });
        return updated;
      })) as [NotificationDestinationRow];
    } catch (error) {
      if (newRef) await this.secrets.delete(newRef).catch(() => undefined);
      throw error;
    }
    const released = newRef ? before.secretRef : dropRef;
    if (released) await this.secrets.delete(released).catch(() => undefined);
    return this.view(row, true);
  }

  /** Stop action: immediate, never gated, allowed while a proposal is open. Re-enabling is an ACTIVATE proposal. */
  async disable(actor: ActorContext, id: string): Promise<NotificationDestinationView> {
    this.assertManage(actor);
    const row = await this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(notificationDestinations).where(eq(notificationDestinations.id, id)).for('update');
      if (!locked) throw notFound('notification_destination', id);
      if (!locked.enabled) return locked;
      const [updated] = await tx.update(notificationDestinations).set({ enabled: false, updatedAt: new Date() }).where(eq(notificationDestinations.id, id)).returning();
      await recordAudit(tx, actor, { action: 'notification_destination.disable', targetType: 'notification_destination', targetId: id, summary: `Disabled destination "${locked.name}"`, before: { enabled: true }, after: { enabled: false } });
      await emitEvent(tx, actor, 'config.changed', { area: 'notification_destinations', entityId: id });
      return updated!;
    });
    return this.view(row, true);
  }

  /**
   * The payload of an UPDATE proposal: the configuration is validated now, and a new secret value is stored as
   * a NEW secret (the live destination keeps its value until approval) and travels as its ref only.
   */
  async stageChange(actor: ActorContext, id: string, patch: DestinationEdit): Promise<{ payload: DestinationChange; discard: () => Promise<void> }> {
    this.assertManage(actor);
    const before = await this.load(this.db, id);
    const adapter = this.adapter(before.kind);
    const config = patch.config !== undefined ? checkConfig(adapter, patch.config) : before.config;
    const secret = patch.secret !== undefined ? checkSecret(adapter, config, patch.secret) : null;
    const owner = { kind: 'notification_destination', objectId: id, makerId: actor.principal!.userId };
    const name = patch.name ?? before.name;
    const staged = secret
      ? await stageSecrets(this.db, this.secrets, owner, { name: `alert destination ${name}`, kind: () => adapter.secret?.secretKind ?? 'OTHER', usedBy: `notification_destination:${name}` }, { secret })
      : [];
    const credentialRef = staged[0]?.ref;
    const payload: DestinationChange = {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.config !== undefined ? { config } : {}),
      ...(credentialRef ? { credentialRef } : {}),
    };
    return { payload, discard: () => unstageSecrets(this.db, this.secrets, staged.map((c) => c.ref)) };
  }

  /** Deleting a destination is always a proposal (DELETE, destination-approval.ts): 409 approval_required here. */
  async delete(actor: ActorContext, id: string): Promise<void> {
    this.assertManage(actor);
    await this.load(this.db, id);
    throw approvalRequiredError('notification_destination', id, 'DELETE');
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

  /** Managers, and rule editors (who attach destinations to rules). Returns whether the actor manages destinations. */
  private assertRead(actor: ActorContext): boolean {
    const principal = requirePrincipal(actor, 'notification_destinations.read');
    const manager = can(principal, Permission.NOTIFICATION_DESTINATIONS_MANAGE);
    const editor = can(principal, Permission.ALERT_RULES_TECHNICAL_MANAGE) || can(principal, Permission.ALERT_RULES_BUSINESS_MANAGE);
    if (!manager && !editor) throw forbidden(Permission.NOTIFICATION_DESTINATIONS_MANAGE);
    return manager;
  }

  private view(row: NotificationDestinationRow, includeConfig: boolean): NotificationDestinationView {
    return toDestinationView(row, includeConfig, this.registry.find(row.kind));
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
    if (secret) throw validation('secret_not_supported', `${adapter.label} destinations${adapter.secret?.when ? ' with this configuration' : ''} do not take a secret`);
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
