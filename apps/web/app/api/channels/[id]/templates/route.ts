import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ApiError } from '@/lib/api/errors';
import { loadChannelTemplates } from '@/lib/api/templates';

const Id = z.uuid();

/**
 * Message templates of a channel for the workspace composer's template
 * picker (browser-initiated, loaded when the picker opens). Proxies
 * GET /v1/channels/:id/templates with the session token; `?refresh=true`
 * bypasses the API's ~5 minute provider cache.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!Id.safeParse(id).success) return Response.json({ error: { code: 'invalid_channel', message: 'Unknown channel' } }, { status: 400 });
  try {
    const list = await loadChannelTemplates(id, request.nextUrl.searchParams.get('refresh') === 'true');
    return Response.json(list, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 500;
    const code = err instanceof ApiError ? err.code : 'internal';
    const message = err instanceof ApiError ? err.message : 'Could not load templates';
    return Response.json({ error: { code, message } }, { status, headers: { 'cache-control': 'no-store' } });
  }
}
