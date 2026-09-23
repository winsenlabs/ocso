import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { normalizeTag } from '@/components/workspace/lib/tags';
import { loadTagSuggestions } from '@/lib/api/conversations';
import { ApiError } from '@/lib/api/errors';

/**
 * Tag autocomplete for the workspace (rail tag editor, resolve dialog, inbox
 * tag filter). Proxies GET /v1/conversations/tags with the session token; the
 * API counts only conversations this user can see.
 */
const Query = z.object({
  prefix: z.string().max(40).transform(normalizeTag).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export async function GET(request: NextRequest): Promise<Response> {
  const params = Object.fromEntries([...request.nextUrl.searchParams].filter(([, v]) => v !== ''));
  const parsed = Query.safeParse(params);
  if (!parsed.success) {
    return Response.json({ error: { category: 'validation', code: 'invalid_query', message: 'Invalid tag query' } }, { status: 400 });
  }
  try {
    const tags = await loadTagSuggestions(parsed.data.prefix || undefined, parsed.data.limit);
    return Response.json(tags, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 500;
    const message = err instanceof ApiError ? err.message : 'Could not load tags';
    const code = err instanceof ApiError ? err.code : 'internal';
    return Response.json({ error: { code, message } }, { status });
  }
}
