import { and, eq, sql } from 'drizzle-orm';
import { Permission, assertCan, type Principal } from '@ocso/auth';
import { validation } from '@ocso/domain';
import { conversations, type Db, type DbOrTx } from '@ocso/db';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { conversationScope, type VisibilityPolicy } from './access.js';
import { lockConversation } from './control.js';

/** A stored tag: lowercase, starts with a letter or digit, then letters, digits, spaces, "-" or "_" (≤ 40 chars). */
export const TAG_PATTERN = /^[a-z0-9][a-z0-9 _-]{0,39}$/;
export const MAX_TAGS = 20;
/** Autocomplete looks at conversations active in this window (keeps the query bounded on large deployments). */
export const TAG_SUGGESTION_WINDOW_DAYS = 90;

/** trim → lowercase → collapse inner whitespace. Idempotent; validity is checked separately. */
export const normalizeTag = (raw: string): string => raw.trim().toLowerCase().replace(/\s+/g, ' ');

const TAG_MESSAGE = 'Tags are 1–40 characters: letters, digits, spaces, "-" or "_", starting with a letter or digit';

/** One tag as sent by a client; normalized before validation. */
export const TagSchema = z.string().max(200).transform(normalizeTag).pipe(z.string().regex(TAG_PATTERN, TAG_MESSAGE));

/** A tag list: each normalized, then de-duplicated (first occurrence wins), at most MAX_TAGS. */
export const TagListSchema = z
  .array(TagSchema)
  .max(100)
  .transform((tags) => [...new Set(tags)])
  .pipe(z.array(z.string()).max(MAX_TAGS, `At most ${MAX_TAGS} tags per conversation`));

export const SetTagsInput = z.object({ tags: TagListSchema });
export type SetTagsInput = z.infer<typeof SetTagsInput>;

export const TagSuggestionQuery = z.object({
  prefix: z.string().max(40).transform(normalizeTag).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type TagSuggestionQuery = z.infer<typeof TagSuggestionQuery>;

export interface TagCount {
  tag: string;
  count: number;
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((t) => b.includes(t));

/** "+refund −emi" style diff for audit summaries. */
export function describeTagChange(before: readonly string[], after: readonly string[]): string {
  const added = after.filter((t) => !before.includes(t)).map((t) => `+${t}`);
  const removed = before.filter((t) => !after.includes(t)).map((t) => `−${t}`);
  return [...added, ...removed].join(' ') || 'no change';
}

/**
 * The single write path for conversation tags, inside the caller's
 * transaction: locks the row, applies `next(current)`, and — only when the set
 * changed — writes an audit record (before/after) and a
 * `conversation.updated { fields: ['tags'] }` event for live screens.
 */
export async function writeConversationTags(
  tx: DbOrTx,
  actor: ActorContext,
  conversationId: string,
  next: (current: readonly string[]) => string[],
  now: Date,
): Promise<string[]> {
  const conv = await lockConversation(tx, conversationId);
  const before = conv.tags;
  const after = next(before);
  if (after.length > MAX_TAGS) throw validation('too_many_tags', `At most ${MAX_TAGS} tags per conversation`);
  if (sameSet(before, after)) return before;
  await tx.update(conversations).set({ tags: after, updatedAt: now }).where(eq(conversations.id, conversationId));
  const who = actor.principal?.displayName ?? actor.system?.name ?? 'system';
  await recordAudit(tx, actor, {
    action: 'conversation.tags_changed',
    targetType: 'conversation',
    targetId: conversationId,
    summary: `tags changed by ${who}: ${describeTagChange(before, after)}`,
    before: { tags: before },
    after: { tags: after },
  });
  await emitEvent(tx, actor, 'conversation.updated', { fields: ['tags'] }, { conversationId, agentId: conv.agentId });
  return after;
}

/** Replace a conversation's tags (PUT semantics). Resource access is checked by the caller. */
export async function setConversationTags(db: Db, actor: ActorContext, conversationId: string, input: SetTagsInput, now = new Date()): Promise<{ tags: string[] }> {
  assertCan(actor.principal!, Permission.CONVERSATIONS_NOTE);
  const tags = TagListSchema.parse(input.tags);
  const saved = await db.transaction((tx) => writeConversationTags(tx, actor, conversationId, () => tags, now));
  return { tags: saved };
}

/**
 * Most used tags on conversations this principal can see (autocomplete),
 * optionally narrowed to a prefix. Only conversations active in the last
 * TAG_SUGGESTION_WINDOW_DAYS are counted.
 */
export async function tagSuggestions(db: DbOrTx, principal: Principal, policy: VisibilityPolicy, q: TagSuggestionQuery, now = new Date()): Promise<{ items: TagCount[] }> {
  assertCan(principal, Permission.CONVERSATIONS_READ);
  const since = new Date(now.getTime() - TAG_SUGGESTION_WINDOW_DAYS * 86_400_000);
  const scope = conversationScope(principal, policy);
  const where = and(
    scope ?? undefined,
    sql`${conversations.lastInteractionAt} >= ${since.toISOString()}::timestamptz`,
    sql`cardinality(${conversations.tags}) > 0`,
  );
  const prefix = q.prefix ? sql`AND starts_with(t.tag, ${q.prefix})` : sql``;
  const { rows } = await db.execute<{ tag: string; n: number }>(sql`
    SELECT t.tag, count(*)::int AS n
      FROM ${conversations} CROSS JOIN LATERAL unnest(${conversations.tags}) AS t(tag)
     WHERE ${where} ${prefix}
     GROUP BY t.tag
     ORDER BY n DESC, t.tag
     LIMIT ${q.limit}`);
  return { items: rows.map((r) => ({ tag: r.tag, count: Number(r.n) })) };
}
