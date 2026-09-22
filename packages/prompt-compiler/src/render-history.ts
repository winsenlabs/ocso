import { isMediaPart, partToPlainText, type InteractionPart, type ModelContentPart, type ModelMessage } from '@ocso/domain';
import { neutralize } from './render-context.js';
import type { HistoryEntry, ModelInputCapabilities } from './types.js';

const HUMAN_MARKER = (name?: string) => `[human colleague${name ? ` ${neutralize(name)}` : ''}]`;

function renderPart(
  part: InteractionPart,
  includeMedia: boolean,
  caps: ModelInputCapabilities,
): ModelContentPart | null {
  if (part.type === 'TOOL_RESULT') return null; // internal, never replayed as conversation
  if (part.type === 'TEXT') return { type: 'text', text: part.text };
  if (isMediaPart(part) && includeMedia && part.media.status === 'STORED' && part.media.blobKey) {
    if (part.type === 'IMAGE' && caps.imageInput) {
      return { type: 'image', blobKey: part.media.blobKey, mimeType: part.media.mimeType };
    }
    if (part.type === 'DOCUMENT' && caps.fileInput) {
      return { type: 'file', blobKey: part.media.blobKey, mimeType: part.media.mimeType, filename: part.media.filename };
    }
    if (part.type === 'AUDIO' && caps.audioInput) {
      return { type: 'file', blobKey: part.media.blobKey, mimeType: part.media.mimeType };
    }
  }
  return { type: 'text', text: partToPlainText(part) };
}

function roleOf(entry: HistoryEntry): 'user' | 'assistant' | null {
  if (entry.actorType === 'CUSTOMER') return 'user';
  if (entry.actorType === 'AGENT' || entry.actorType === 'HUMAN') return 'assistant';
  return null; // SYSTEM entries are represented in the conversation frame / summary
}

/**
 * Convert history into provider-neutral messages. Consecutive entries from the
 * same side are merged (several providers require strict alternation), and the
 * sequence always starts with a user message.
 */
export function renderHistory(
  entries: readonly HistoryEntry[],
  caps: ModelInputCapabilities,
  mediaWindow: number,
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  entries.forEach((entry, index) => {
    const role = roleOf(entry);
    if (!role) return;
    const includeMedia = entries.length - index <= mediaWindow;
    const content: ModelContentPart[] = [];
    if (entry.actorType === 'HUMAN') content.push({ type: 'text', text: HUMAN_MARKER(entry.actorName) });
    for (const part of entry.parts) {
      const rendered = renderPart(part, includeMedia, caps);
      if (rendered) content.push(rendered);
    }
    if (content.length === 0) return;
    const last = messages.at(-1);
    if (last && last.role === role) last.content.push(...content);
    else messages.push({ role, content });
  });
  if (messages[0]?.role === 'assistant') {
    messages.unshift({ role: 'user', content: [{ type: 'text', text: '(The organization started this conversation.)' }] });
  }
  return messages;
}
