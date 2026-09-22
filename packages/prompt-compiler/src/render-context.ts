import { canonicalJson } from './hash.js';
import type { CompileInput } from './types.js';

/**
 * Untrusted/dynamic data is wrapped in explicit tags and neutralized so it can
 * never close its own wrapper and masquerade as instructions (docs/05 §7).
 */
export function neutralize(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/<\/?(ocso_[a-z_]+|customer_context|conversation_summary|handover|conversation)>/gi, (m) =>
      m.replace('<', '‹').replace('>', '›'),
    );
}

export function wrap(tag: string, body: string): string {
  return `<${tag}>\n${body.trim()}\n</${tag}>`;
}

export function renderCustomerContext(input: CompileInput): string | null {
  const c = input.customer;
  if (!c) return null;
  const data = {
    customer_id: c.customerId,
    name: c.displayName,
    language: c.language,
    attributes: c.attributes,
  };
  return wrap('customer_context', neutralize(canonicalJson(data)));
}

export function renderSummary(input: CompileInput): string | null {
  const s = input.summary;
  if (!s || !s.text.trim()) return null;
  return wrap(
    'conversation_summary',
    `Summary v${s.version} of the conversation up to message ${s.coversThroughSeq}. Older messages are available through ocso_search_history.\n${neutralize(s.text)}`,
  );
}

export function renderHandover(input: CompileInput): string | null {
  const h = input.handover;
  if (!h) return null;
  const who = h.humanName ? `${neutralize(h.humanName)} (human colleague)` : 'A human colleague';
  const notes = h.notes.length ? `\nNotes passed to you:\n${h.notes.map((n) => `- ${neutralize(n)}`).join('\n')}` : '';
  return wrap(
    'handover',
    `${who} handled the conversation and has returned it to you. Continue from here; do not repeat what they already told the customer.\n${neutralize(h.summary)}${notes}`,
  );
}

export function renderConversationFrame(input: CompileInput): string {
  return wrap(
    'conversation',
    [
      `Agent: ${neutralize(input.agent.name)}`,
      `Conversation type: ${input.agent.conversationType}`,
      `Current channel: ${neutralize(input.channel.label)} (${input.channel.kind})`,
      `Today: ${input.today}`,
    ].join('\n'),
  );
}
