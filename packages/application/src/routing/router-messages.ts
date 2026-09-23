import { and, eq, isNull } from 'drizzle-orm';
import {
  TEMPLATE_MESSAGE_SCHEMA,
  choicesPart,
  renderTemplate,
  isTemplateSendable,
  type InteractionPart,
  type MessageSpec,
  type TemplateMessageData,
} from '@ocso/domain';
import { messageTemplates, type DbOrTx } from '@ocso/db';
import { appendInteraction } from '../conversations/interaction-writer.js';
import { conversationWindow, type SessionWindowHours } from '../conversations/session-window.js';
import { rowAsTemplate } from '../channels/message-templates-view.js';
import { emitEvent } from '../events/outbox.js';

export interface RouterMessageInput {
  conversation: { id: string; customerId: string; channelId: string | null };
  routerId: string;
  message: MessageSpec;
  options: Array<{ id: string; label: string }> | null;
  correlationId: string;
  now: Date;
  /** The channel's session window (from its adapter); without it the text is always sent. */
  windowHours?: SessionWindowHours | undefined;
}

/**
 * The approved template mapped for this channel, as a template-message part
 * (sent through the adapter's sendTemplate). Null when none is mapped, it is
 * gone, not approved, or needs values the router cannot fill.
 */
async function templatePart(tx: DbOrTx, channelId: string, templateId: string): Promise<InteractionPart | null> {
  const [row] = await tx
    .select()
    .from(messageTemplates)
    .where(and(eq(messageTemplates.id, templateId), eq(messageTemplates.channelId, channelId), isNull(messageTemplates.deletedAt)));
  if (!row) return null;
  const template = rowAsTemplate(row);
  if (!isTemplateSendable(template) || template.variables.length) return null;
  const rendered = renderTemplate(template, {});
  const data: TemplateMessageData = { templateId: template.id, name: template.name, language: template.language, category: template.category, variables: {}, template };
  return { type: 'STRUCTURED', schema: TEMPLATE_MESSAGE_SCHEMA, data: data as unknown as Record<string, unknown>, fallbackText: rendered.text.slice(0, 4_000) };
}

/**
 * A router's message to the customer (PM/research/11 §5.3): an OUTBOUND
 * interaction with actor ROUTER, delivered like any reply (`channel.deliver`).
 * A question with options is a CHOICES part. Outside the channel's session
 * window the per-channel template is sent when one is mapped; otherwise the
 * text goes out and delivery records `session_window_closed`.
 * Returns the interaction id to publish for delivery after commit.
 */
export async function writeRouterMessage(tx: DbOrTx, input: RouterMessageInput): Promise<string> {
  const { conversation: conv, now } = input;
  let parts: InteractionPart[] = [input.options ? choicesPart({ text: input.message.text, options: input.options }) : { type: 'TEXT', text: input.message.text }];
  const mapped = conv.channelId ? input.message.templates?.[conv.channelId] : undefined;
  if (mapped && conv.channelId) {
    const window = await conversationWindow(tx, conv, input.windowHours, now);
    if (window && !window.open) parts = [(await templatePart(tx, conv.channelId, mapped)) ?? parts[0]!];
  }
  const appended = await appendInteraction(
    tx,
    conv.id,
    { actorType: 'ROUTER', actorId: input.routerId, direction: 'OUTBOUND', visibility: 'CUSTOMER', idempotencyKey: null, correlationId: input.correlationId, parts },
    { channelId: conv.channelId, deliveryStatus: 'PENDING', now },
  );
  await emitEvent(tx, { correlationId: input.correlationId }, 'interaction.sent', { interactionId: appended.interactionId, seq: appended.seq, actorType: 'ROUTER' }, { conversationId: conv.id });
  return appended.interactionId;
}
