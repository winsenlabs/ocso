import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { Permission, can } from '@ocso/auth';
import { TemplateDraftSchema, checkTemplateDraft, notFound, validation } from '@ocso/domain';
import { channels, messageTemplates, type DbOrTx } from '@ocso/db';
import type { ApprovalDescriptor, ApprovalProblem } from '../approvals/contract.js';
import { CHANNEL_AGENT_REACH } from '../routing/reach.js';
import { TEMPLATE_KIND } from './message-template-drafts.js';
import { deleteTemplateAtProvider, markTemplateDeleted, submitDraftToProvider } from './message-template-provider.js';
import { loadManageableChannel } from './message-templates-access.js';
import type { TemplateProviderSource } from './message-templates.js';
import type { TemplateRow } from './message-templates-view.js';

/**
 * `message_template` (PM/research/11 §4, 11b), checked with
 * approvals.check.channels:
 * - CREATE submits a DRAFT to the channel's provider for review. DEFERRED: the
 *   worker makes the provider call after re-validating (message-template-provider.ts),
 *   so nothing reaches the provider before a checker approved it, and never twice.
 * - DELETE (message_templates.delete, Head) deletes it at the provider
 *   (DEFERRED), or — for a draft the provider never saw — at once.
 * Drafts are edited directly (they are inert); a submitted template is never
 * edited, so there is no UPDATE.
 */

export interface MessageTemplateApprovalDeps {
  /** The channel adapters' template methods; the worker (which finishes deferred activations) provides them. */
  templateProviders?: TemplateProviderSource | undefined;
}

async function rowOf(tx: DbOrTx, id: string): Promise<TemplateRow | null> {
  const [row] = await tx.select().from(messageTemplates).where(and(eq(messageTemplates.id, id), isNull(messageTemplates.deletedAt)));
  return row ?? null;
}

function draftOf(row: TemplateRow) {
  const parsed = TemplateDraftSchema.safeParse(row.definition);
  return parsed.success ? parsed.data : null;
}

async function channelName(tx: DbOrTx, channelId: string): Promise<string> {
  const [c] = await tx.select({ name: channels.name }).from(channels).where(eq(channels.id, channelId));
  return c?.name ?? 'a deleted channel';
}

function providers(deps: MessageTemplateApprovalDeps): TemplateProviderSource {
  if (!deps.templateProviders) throw new Error('message template approvals need the channel template providers in this process');
  return deps.templateProviders;
}

function contentOf(row: TemplateRow) {
  const draft = draftOf(row);
  return { header: draft?.header ?? null, body: draft?.body ?? null, footer: draft?.footer ?? null, buttons: draft?.buttons ?? [], examples: draft?.examples ?? {} };
}

/**
 * Checker-readable: the channel and, for a template at the provider, its content. A draft's content is not at the
 * provider yet, so it appears only in the submission's `after` — the diff shows the checker every field that goes out.
 * Never secrets.
 */
async function projectTemplate(tx: DbOrTx, id: string): Promise<Record<string, unknown> | null> {
  const row = await rowOf(tx, id);
  if (!row) return null;
  const base = {
    channel: await channelName(tx, row.channelId),
    name: row.name,
    language: row.language,
    category: row.category,
    status: row.providerTemplateId ? row.status : 'DRAFT (not at the provider)',
    madeIn: row.origin === 'PROVIDER' ? "the provider's console" : 'OCSO',
  };
  return row.providerTemplateId ? { ...base, ...contentOf(row) } : base;
}

export function messageTemplateApproval(deps: MessageTemplateApprovalDeps = {}): ApprovalDescriptor {
  return {
    kind: TEMPLATE_KIND,
    label: 'Message template',
    actions: ['CREATE', 'DELETE'],
    makePermission: (action) => (action === 'DELETE' ? Permission.MESSAGE_TEMPLATES_DELETE : Permission.MESSAGE_TEMPLATES_MANAGE),
    checkPermission: Permission.APPROVALS_CHECK_CHANNELS,
    /** Submitting and deleting are always proposals; drafts are edited directly (the service refuses edits once submitted). */
    requiresApproval: async (_tx, _id, action) => action !== 'UPDATE',

    project: projectTemplate,
    async projectAfter(tx, p) {
      if (p.action === 'DELETE') return null;
      const row = await rowOf(tx, p.objectId);
      const before = await projectTemplate(tx, p.objectId);
      return row && before ? { ...before, ...contentOf(row), status: 'Submitted to the provider for review' } : null;
    },
    /** The content (the parsed draft) and identity; never the review status the provider or the poller changes. */
    async hashBasis(tx, id) {
      const row = await rowOf(tx, id);
      if (!row) return null;
      return { channelId: row.channelId, origin: row.origin, draft: draftOf(row), providerTemplateId: row.origin === 'PROVIDER' ? row.providerTemplateId : null };
    },
    /** Teams owning the agents this channel reaches (through its active router); none → platform-wide. */
    async teamIds(tx, id) {
      const row = await rowOf(tx, id);
      if (!row) return [];
      const result = await tx.execute<{ team_id: string }>(
        sql`SELECT DISTINCT at.team_id FROM (${CHANNEL_AGENT_REACH}) AS reach JOIN agent_teams at ON at.agent_id = reach.agent_id WHERE reach.channel_id = ${row.channelId}::uuid`,
      );
      return result.rows.map((r) => r.team_id).sort();
    },
    dependencies: async () => [],
    async assertVisible(tx, principal, id) {
      const row = await rowOf(tx, id);
      if (!row) throw notFound('template', id);
      if (can(principal, Permission.MESSAGE_TEMPLATES_MANAGE)) await loadManageableChannel(tx, principal, row.channelId);
      else if (!can(principal, Permission.CONVERSATIONS_REPLY)) throw notFound('template', id);
    },
    async assertMakeable(tx, principal, id) {
      const row = await rowOf(tx, id);
      if (!row) throw notFound('template', id);
      await loadManageableChannel(tx, principal, row.channelId);
    },
    async validate(tx, p) {
      const row = await rowOf(tx, p.objectId);
      if (!row) return [{ code: 'object_missing', message: 'The template no longer exists.' }];
      if (p.action === 'DELETE') return [];
      const problems: ApprovalProblem[] = [];
      // Once approved, a retry of the deferred submission finds the provider id it stored and is a no-op.
      if (row.providerTemplateId && p.status === 'SUBMITTED') problems.push({ code: 'template_submitted', message: 'This template is at the provider already.' });
      const draft = draftOf(row);
      if (!draft) return [...problems, { code: 'invalid_template', message: 'The draft is not a valid template.' }];
      problems.push(...checkTemplateDraft(draft).problems.map((x) => ({ code: 'invalid_template', message: `${x.field}: ${x.message}` })));
      return problems;
    },
    async activate(tx, actor, p) {
      if (p.action === 'CREATE') return { kind: 'DEFERRED' };
      const row = await rowOf(tx, p.objectId);
      if (!row) throw validation('object_missing', 'The template no longer exists');
      // A draft the provider never saw goes at once; one at the provider is deleted there first (worker).
      if (row.providerTemplateId) return { kind: 'DEFERRED' };
      await markTemplateDeleted(tx, actor, row, await channelName(tx, row.channelId));
      return { kind: 'DONE' };
    },
    async activateDeferred(db, actor, p) {
      if (p.action === 'CREATE') await submitDraftToProvider(db, providers(deps), actor, p.objectId);
      else await deleteTemplateAtProvider(db, providers(deps), actor, p.objectId);
    },
    /**
     * The provider step committed but the worker died before stamping the proposal: the template carries its provider
     * id (CREATE) or is marked deleted (DELETE). Re-checking the hashes would now compare against that and block.
     */
    async settled(db, p) {
      const [row] = await db.select({ providerTemplateId: messageTemplates.providerTemplateId, deletedAt: messageTemplates.deletedAt }).from(messageTemplates).where(eq(messageTemplates.id, p.objectId));
      if (!row) return false;
      return p.action === 'DELETE' ? row.deletedAt !== null : row.providerTemplateId !== null && row.deletedAt === null;
    },
    /** Templates OCSO put at the provider (submitted, not deleted). Provider-made records were never OCSO's to approve. */
    async liveObjects(tx) {
      const rows = await tx
        .select({ id: messageTemplates.id })
        .from(messageTemplates)
        .where(and(eq(messageTemplates.origin, 'OCSO'), isNotNull(messageTemplates.providerTemplateId), isNull(messageTemplates.deletedAt)));
      return rows.map((r) => r.id);
    },
    title(p, before) {
      const what = `${String(before?.['name'] ?? 'template')} (${String(before?.['language'] ?? '')})`;
      const where = String(before?.['channel'] ?? 'the channel');
      return p.action === 'DELETE' ? `Delete template ${what} from ${where}` : `Submit template ${what} to ${where}`;
    },
  };
}
