import { eq, sql } from 'drizzle-orm';
import { Permission, assertCan, can } from '@ocso/auth';
import {
  TEMPLATE_MESSAGE_SCHEMA,
  isTemplateSendable,
  renderTemplate,
  templateValueProblems,
  validation,
  type InteractionPart,
  type TemplateMessageData,
} from '@ocso/domain';
import { conversations, type Db, type DbOrTx } from '@ocso/db';
import type { QueueAdapter } from '@ocso/queue';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import type { MessageTemplateService } from '../channels/message-templates.js';
import type { TemplateView } from '../channels/message-templates-view.js';
import { lockConversation } from '../conversations/control.js';
import { appendInteraction } from '../conversations/interaction-writer.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { reopenAsHuman } from './human-control.js';

export const TemplateMessageInput = z.object({
  /** The provider's template id, from GET /v1/channels/:id/templates. */
  templateId: z.string().trim().min(1).max(200),
  language: z.string().trim().min(2).max(16),
  /** Values keyed by the template's variable keys. */
  variables: z.record(z.string().max(80), z.string().max(1_024)).default({}),
  /** Media for templates whose header media is chosen at send time. */
  headerMediaUrl: z.string().trim().max(2_000).optional(),
  /** Client-generated key so a double-click never sends twice. */
  clientMessageId: z.string().min(8).max(100),
  /** On a resolved conversation: reopen it (you become the handler) and send, in one step. */
  reopen: z.boolean().default(false),
});
export type TemplateMessageInput = z.infer<typeof TemplateMessageInput>;

export interface TemplateMessageResult {
  interactionId: string;
  seq: number;
  duplicate: boolean;
  reopened: boolean;
}

const idempotencyKey = (clientMessageId: string) => `template:${clientMessageId}`;

async function existing(db: DbOrTx, conversationId: string, clientMessageId: string): Promise<{ id: string; seq: number } | undefined> {
  const found = await db.execute<{ id: string; seq: number }>(
    sql`SELECT id, seq FROM interactions WHERE conversation_id = ${conversationId} AND idempotency_key = ${idempotencyKey(clientMessageId)}`,
  );
  return found.rows[0];
}

function assertSendable(template: TemplateView | null, input: TemplateMessageInput): TemplateView {
  if (!template) throw validation('template_not_found', 'This template is not available on the conversation’s channel (refresh the template list)');
  if (template.language !== input.language) throw validation('template_language_mismatch', `${template.name} is a ${template.language} template, not ${input.language}`);
  if (template.unsupportedReason) throw validation('template_unsupported', template.unsupportedReason);
  if (!isTemplateSendable(template)) {
    throw validation('template_not_approved', `${template.name} is ${template.status.toLowerCase()}: only approved templates can be sent`);
  }
  const problems = templateValueProblems(template, input.variables, input.headerMediaUrl);
  if (problems.length) throw validation('template_variables_invalid', problems.map((p) => p.message).join('; '), { problems });
  return template;
}

/**
 * Send an approved message template to the customer (docs/archive/specs/07 §3, docs/archive/specs/09
 * §4): the only way to reach them after the channel's customer-service
 * window closes, and allowed inside it too. Same holder rule as a human reply (HUMAN_ACTIVE, the
 * assigned human or a lead). A resolved conversation can be reopened and
 * sent to in one step (`reopen: true`), because staff may reopen (REOPEN by a
 * human lands in HUMAN_ACTIVE with them as the handler). The interaction
 * stores the filled text plus the template metadata, so the timeline and
 * the customer history show exactly what was sent; delivery goes through
 * the channel adapter's sendTemplate.
 */
export async function sendTemplateMessage(
  db: Db,
  queue: QueueAdapter,
  actor: ActorContext,
  conversationId: string,
  input: TemplateMessageInput,
  deps: { templates: MessageTemplateService; now?: (() => Date) | undefined },
): Promise<TemplateMessageResult> {
  const p = actor.principal!;
  assertCan(p, Permission.CONVERSATIONS_REPLY);
  const [conv] = await db.select({ channelId: conversations.channelId }).from(conversations).where(eq(conversations.id, conversationId));
  if (!conv?.channelId) throw validation('no_channel', 'This conversation has no channel to send a template on');
  const before = await existing(db, conversationId, input.clientMessageId);
  if (before) return { interactionId: before.id, seq: before.seq, duplicate: true, reopened: false };

  const template = assertSendable(await deps.templates.find(conv.channelId, input.templateId), input);
  const rendered = renderTemplate(template, input.variables, input.headerMediaUrl);
  const { submission: _submission, ...definition } = template;
  const data: TemplateMessageData = {
    templateId: template.id,
    name: template.name,
    language: template.language,
    category: template.category,
    variables: { ...input.variables },
    ...(input.headerMediaUrl ? { headerMediaUrl: input.headerMediaUrl } : {}),
    template: definition,
  };
  const part: InteractionPart = { type: 'STRUCTURED', schema: TEMPLATE_MESSAGE_SCHEMA, data: data as unknown as Record<string, unknown>, fallbackText: rendered.text.slice(0, 4_000) };

  const result = await db.transaction(async (tx) => {
    const now = deps.now?.() ?? new Date();
    let current = await lockConversation(tx, conversationId);
    let reopened = false;
    if (current.controlState === 'RESOLVED') {
      if (!input.reopen) throw validation('conversation_resolved', 'Reopen the conversation to send a template');
      await reopenAsHuman(tx, actor, conversationId, now);
      current = await lockConversation(tx, conversationId);
      reopened = true;
    }
    if (current.controlState !== 'HUMAN_ACTIVE') throw validation('not_human_active', 'Take over or claim the conversation before sending a template');
    if (current.assignedUserId !== p.userId && !can(p, Permission.CONVERSATIONS_ASSIGN)) throw validation('not_handler', 'Only the human handling this conversation can send');
    const race = await existing(tx, conversationId, input.clientMessageId);
    if (race) return { interactionId: race.id, seq: race.seq, duplicate: true, reopened };
    const appended = await appendInteraction(
      tx,
      conversationId,
      { actorType: 'HUMAN', actorId: p.userId, direction: 'OUTBOUND', visibility: 'CUSTOMER', idempotencyKey: idempotencyKey(input.clientMessageId), correlationId: actor.correlationId, parts: [part] },
      { channelId: current.channelId, deliveryStatus: 'PENDING', now },
    );
    await tx
      .update(conversations)
      .set({ lastProcessedSeq: appended.seq, ...(current.firstHumanResponseAt ? {} : { firstHumanResponseAt: now }) })
      .where(eq(conversations.id, conversationId));
    await recordAudit(tx, actor, {
      action: 'conversation.template_sent',
      targetType: 'conversation',
      targetId: conversationId,
      summary: `Sent message template ${template.name} (${template.language}${template.category ? `, ${template.category.toLowerCase()}` : ''})${reopened ? ' after reopening' : ''}`,
      // Values can hold customer data: the audit keeps which variables were filled, the timeline keeps the text.
      after: { interactionId: appended.interactionId, templateId: template.id, name: template.name, language: template.language, category: template.category, variables: Object.keys(input.variables) },
    });
    await emitEvent(tx, actor, 'human.message_sent', { interactionId: appended.interactionId, userId: p.userId }, { conversationId, agentId: current.agentId });
    return { ...appended, duplicate: false, reopened };
  });
  if (!result.duplicate) {
    await queue.publish('channel.deliver', { interactionId: result.interactionId }, { groupKey: conversationId, dedupeKey: `deliver:${result.interactionId}` });
  }
  return result;
}
