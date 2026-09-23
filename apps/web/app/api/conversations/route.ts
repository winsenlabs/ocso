import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { TAG_PATTERN, normalizeTag } from '@/components/workspace/lib/tags';
import { INBOX_VIEWS, loadInbox } from '@/lib/api/conversations';
import { ApiError } from '@/lib/api/errors';

/**
 * Browser-side inbox refresh for the workspace (design/01 left pane): the
 * client re-queries when the view, search or filters (agent, queue, tag)
 * change and when realtime events arrive. Proxies GET /v1/conversations with
 * the session token.
 */
const Query = z.object({
  view: z.enum(INBOX_VIEWS).default('all'),
  search: z.string().trim().max(200).optional(),
  agentId: z.uuid().optional(),
  queueId: z.uuid().optional(),
  tag: z.string().max(80).transform(normalizeTag).pipe(z.string().regex(TAG_PATTERN)).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(request: NextRequest): Promise<Response> {
  const params = Object.fromEntries([...request.nextUrl.searchParams].filter(([, v]) => v !== ''));
  const parsed = Query.safeParse(params);
  if (!parsed.success) {
    return Response.json({ error: { category: 'validation', code: 'invalid_query', message: 'Invalid inbox query' } }, { status: 400 });
  }
  try {
    const inbox = await loadInbox(parsed.data);
    return Response.json(inbox, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 500;
    const message = err instanceof ApiError ? err.message : 'Could not load conversations';
    const code = err instanceof ApiError ? err.code : 'internal';
    return Response.json({ error: { code, message } }, { status });
  }
}
