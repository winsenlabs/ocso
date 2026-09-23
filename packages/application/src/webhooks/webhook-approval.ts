import { eq } from 'drizzle-orm';
import { Permission } from '@ocso/auth';
import { webhookSubscriptions, type DbOrTx } from '@ocso/db';
import type { SecretStore } from '@ocso/secrets';
import { recordAudit } from '../audit/audit.js';
import type { ApprovalDescriptor, ProposalRow } from '../approvals/contract.js';
import { platformRequiresApproval, platformTitle, platformVisible } from '../settings/platform-approvals.js';
import { releaseSecrets } from '../settings/secret-refs.js';
import { WebhookChange } from './subscriptions.js';

/**
 * Outbound webhook subscriptions under maker–checker (PM/research/11 §4, approvals.check.platform). A
 * subscription is created disabled — a draft the relay never fans out to. Enabling is ACTIVATE (first time
 * and resume); disabling is a stop action. Once approved, a change of name, URL or events is an UPDATE
 * proposal (no secrets travel: the signing secret is OCSO's own, rotated directly — a revocation). DELETE is
 * always a proposal.
 */

type WebhookRow = typeof webhookSubscriptions.$inferSelect;

async function load(tx: DbOrTx, id: string): Promise<WebhookRow | null> {
  const [row] = await tx.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, id));
  return row ?? null;
}

const projectRow = (row: WebhookRow, change?: WebhookChange): Record<string, unknown> => ({
  name: change?.name ?? row.name,
  url: change?.url ?? row.url,
  events: [...(change?.events ?? row.events)].sort(),
  enabled: row.enabled,
});

export function webhookApproval(_deps: { secrets?: SecretStore | undefined } = {}): ApprovalDescriptor {
  return {
    kind: 'webhook_subscription',
    label: 'Webhook subscription',
    actions: ['ACTIVATE', 'UPDATE', 'DELETE'],
    makePermission: () => Permission.WEBHOOKS_MANAGE,
    checkPermission: Permission.APPROVALS_CHECK_PLATFORM,
    payload: WebhookChange,
    hashExclude: ['enabled'],

    async project(tx, id) {
      const row = await load(tx, id);
      return row ? projectRow(row) : null;
    },
    async projectAfter(tx, p) {
      const row = await load(tx, p.objectId);
      if (!row || p.action === 'DELETE') return null;
      if (p.action === 'ACTIVATE') return { ...projectRow(row), enabled: true };
      return projectRow(row, p.payload as WebhookChange);
    },
    teamIds: async () => [],
    dependencies: async () => [],
    assertVisible: platformVisible(Permission.WEBHOOKS_MANAGE),
    requiresApproval: platformRequiresApproval('webhook_subscription'),
    async validate(tx, p) {
      const row = await load(tx, p.objectId);
      if (!row) return [{ code: 'object_missing', message: 'The webhook no longer exists.' }];
      if (p.action === 'ACTIVATE' && row.enabled) return [{ code: 'already_enabled', message: 'The webhook is already enabled.' }];
      return [];
    },
    async activate(tx, actor, p) {
      const row = (await load(tx, p.objectId))!;
      if (p.action === 'DELETE') {
        await tx.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, row.id));
        await recordAudit(tx, actor, {
          action: 'webhook.delete',
          targetType: 'webhook',
          targetId: row.id,
          summary: `Webhook ${row.name} deleted`,
          before: { name: row.name, url: row.url, events: row.events, enabled: row.enabled },
        });
        await releaseSecrets(tx, { kind: 'webhook_subscription', objectId: row.id }, [row.signingSecretRef]);
      } else if (p.action === 'ACTIVATE') {
        await tx.update(webhookSubscriptions).set({ enabled: true, updatedAt: new Date() }).where(eq(webhookSubscriptions.id, row.id));
        await recordAudit(tx, actor, { action: 'webhook.enable', targetType: 'webhook', targetId: row.id, summary: `Webhook ${row.name} enabled`, before: { enabled: false }, after: { enabled: true } });
      } else {
        const change = p.payload as WebhookChange;
        await tx.update(webhookSubscriptions).set({ ...change, updatedAt: new Date() }).where(eq(webhookSubscriptions.id, row.id));
        await recordAudit(tx, actor, { action: 'webhook.update', targetType: 'webhook', targetId: row.id, summary: `Webhook ${row.name} updated`, before: { name: row.name, url: row.url, events: row.events }, after: change });
      }
      return { kind: 'DONE' };
    },
    async liveObjects(tx) {
      return (await tx.select({ id: webhookSubscriptions.id }).from(webhookSubscriptions).where(eq(webhookSubscriptions.enabled, true))).map((r) => r.id);
    },
    title: (p: ProposalRow, before) => platformTitle(p, before, { noun: 'webhook', activateVerb: 'Enable' }),
  };
}
