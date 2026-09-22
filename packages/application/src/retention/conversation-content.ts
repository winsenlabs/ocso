import { sql } from 'drizzle-orm';
import type { Db } from '@ocso/db';

export const REDACTED_TEXT = '[Removed under the retention policy]';
const BATCH = 200;

/**
 * Removes the content of RESOLVED conversations older than the cutoff while
 * keeping the structure analytics depend on (conversation, interaction rows,
 * seq, actors, timestamps, handoffs, insights). Returns the blob keys to delete
 * once the transaction has committed.
 */
export async function purgeConversationContent(db: Db, cutoff: Date): Promise<{ conversations: number; blobKeys: string[] }> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT id FROM conversations
       WHERE control_state = 'RESOLVED' AND resolved_at < ${cutoff} AND content_purged_at IS NULL
       ORDER BY resolved_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`);
    if (!rows.length) return { conversations: 0, blobKeys: [] };
    const ids = sql`ARRAY[${sql.join(rows.map((r) => sql`${r.id}::uuid`), sql`, `)}]`;
    const blobs = await tx.execute<{ blob_key: string }>(sql`
      SELECT p.blob_key FROM interaction_parts p JOIN interactions i ON i.id = p.interaction_id
       WHERE i.conversation_id = ANY(${ids}) AND p.blob_key IS NOT NULL`);
    // Media parts keep their type and MIME type; everything else becomes a redacted text part.
    await tx.execute(sql`
      UPDATE interaction_parts p SET
        type = CASE WHEN p.content ? 'media' THEN p.type ELSE 'TEXT' END,
        content = CASE
          WHEN p.content ? 'media' THEN jsonb_build_object('type', p.type, 'media',
            jsonb_build_object('mimeType', p.content->'media'->'mimeType', 'status', 'EXPIRED'))
          ELSE jsonb_build_object('type', 'TEXT', 'text', ${REDACTED_TEXT}::text) END,
        blob_key = NULL,
        media_status = CASE WHEN p.media_status IS NULL THEN NULL ELSE 'EXPIRED' END
      FROM interactions i WHERE i.id = p.interaction_id AND i.conversation_id = ANY(${ids})`);
    await tx.execute(sql`UPDATE interactions SET preview = NULL, delivery_error = NULL WHERE conversation_id = ANY(${ids})`);
    await tx.execute(sql`UPDATE internal_notes SET body = ${REDACTED_TEXT} WHERE conversation_id = ANY(${ids})`);
    await tx.execute(sql`UPDATE tool_calls SET args_sanitized = '{}'::jsonb, result_summary = NULL, pending_args = NULL, error_message = NULL WHERE conversation_id = ANY(${ids})`);
    await tx.execute(sql`UPDATE handoffs SET reason_text = reason_code, agent_summary = NULL, handover_summary = NULL WHERE conversation_id = ANY(${ids})`);
    await tx.execute(sql`UPDATE csat_responses SET comment = NULL WHERE conversation_id = ANY(${ids})`);
    await tx.execute(sql`UPDATE conversation_reviews SET notes = NULL WHERE conversation_id = ANY(${ids})`);
    // Replay evaluations copy customer text; results for purged conversations go (run summaries stay).
    await tx.execute(sql`DELETE FROM evaluation_results WHERE conversation_id = ANY(${ids})`);
    await tx.execute(sql`DELETE FROM conversation_summaries WHERE conversation_id = ANY(${ids})`);
    await tx.execute(sql`DELETE FROM copilot_suggestions WHERE conversation_id = ANY(${ids})`);
    await tx.execute(sql`DELETE FROM context_snapshots WHERE conversation_id = ANY(${ids})`);
    await tx.execute(sql`UPDATE conversations SET content_purged_at = now() WHERE id = ANY(${ids})`);
    return { conversations: rows.length, blobKeys: blobs.rows.map((b) => b.blob_key) };
  });
}
