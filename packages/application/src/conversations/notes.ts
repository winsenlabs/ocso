import { Permission, assertCan } from '@ocso/auth';
import { internalNotes, uuidv7, type Db } from '@ocso/db';
import { z } from 'zod';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';

export const NoteInput = z.object({
  body: z.string().trim().min(1).max(8_000),
  /** Include this note in the handover context when control returns to the AI. */
  passToAgent: z.boolean().default(false),
});
export type NoteInput = z.infer<typeof NoteInput>;

/** Internal notes (docs/09 §5, ADR-013): staff-only, never rendered to customers. */
export async function addNote(db: Db, actor: ActorContext, conversationId: string, input: NoteInput): Promise<{ id: string }> {
  const principal = actor.principal!;
  assertCan(principal, Permission.CONVERSATIONS_NOTE);
  const id = uuidv7();
  await db.transaction(async (tx) => {
    await tx.insert(internalNotes).values({ id, conversationId, authorId: principal.userId, body: input.body, passToAgent: input.passToAgent });
    await emitEvent(tx, actor, 'note.added', { noteId: id, userId: principal.userId }, { conversationId });
  });
  return { id };
}
