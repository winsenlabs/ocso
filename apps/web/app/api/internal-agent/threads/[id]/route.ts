import { z } from 'zod';
import { historyToMessages } from '@/components/internal-agent/history';
import type { ThreadHistory } from '@/components/internal-agent/types';
import { ApiError } from '@/lib/api/errors';
import { getInternalAgentMessages } from '@/lib/api/internal-agent';
import { jsonError } from '../../forward';

/**
 * GET /api/internal-agent/threads/:id — one of the user's own threads as chat
 * messages (the API answers 404 for anyone else's). Action cards carry their
 * current status, so a decided action never shows Confirm again.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, 'not_found', 'not_found', 'Conversation not found');
  try {
    const rows = await getInternalAgentMessages(id.data);
    return Response.json({ threadId: id.data, messages: historyToMessages(rows) } satisfies ThreadHistory);
  } catch (err) {
    if (err instanceof ApiError) return jsonError(err.status, err.category, err.code, err.message);
    return jsonError(500, 'internal', 'internal', 'This conversation could not be loaded.');
  }
}
