import { z } from 'zod';
import { DeniedSchema, MiniTableSchema, ObjectLinkSchema, PendingActionSchema, type AskOcsoMessage, type AskOcsoPart } from './types';

/**
 * Thread history (GET /v1/internal-agent/threads/:id/messages) → chat
 * messages. The API stores its own part shapes (packages/internal-agent
 * agent.ts `StoredPart`); this maps them onto the same `data-*` parts the
 * live stream produces, so one renderer serves both. Unknown or malformed
 * parts are dropped rather than guessed at.
 */

export interface StoredMessage {
  id: string;
  role: string;
  parts: unknown[];
}

const StoredPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('links'), links: z.array(ObjectLinkSchema) }),
  z.object({ type: z.literal('table'), table: MiniTableSchema }),
  z.object({ type: z.literal('action'), action: PendingActionSchema }),
  z.object({ type: z.literal('tool'), name: z.string(), ok: z.boolean().optional() }),
  z.object({ type: z.literal('denied'), text: z.string() }),
]);

/** "list_conversations" → "list conversations" (the stream's step label). */
export const stepLabel = (toolName: string) => toolName.replaceAll('_', ' ');

function toPart(raw: unknown): AskOcsoPart | null {
  const parsed = StoredPartSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  switch (p.type) {
    case 'text':
      return { type: 'text', text: p.text, state: 'done' };
    case 'links':
      return { type: 'data-links', data: p.links };
    case 'table':
      return { type: 'data-table', data: p.table };
    case 'action':
      return { type: 'data-action', id: p.action.id, data: p.action };
    case 'tool':
      return { type: 'data-step', data: { label: stepLabel(p.name) } };
    case 'denied':
      return { type: 'data-denied', data: DeniedSchema.parse({ message: p.text }) };
  }
}

export function historyToMessages(rows: readonly StoredMessage[]): AskOcsoMessage[] {
  return rows.flatMap((row): AskOcsoMessage[] => {
    if (row.role !== 'user' && row.role !== 'assistant') return [];
    const parts = row.parts.map(toPart).filter((p): p is AskOcsoPart => p !== null);
    if (row.role === 'user') {
      const text = parts.filter((p) => p.type === 'text');
      return text.length ? [{ id: row.id, role: 'user', parts: text }] : [];
    }
    return [{ id: row.id, role: 'assistant', parts }];
  });
}
