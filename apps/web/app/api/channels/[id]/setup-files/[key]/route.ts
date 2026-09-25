import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiBaseUrl, readSessionToken } from '@/lib/api/client';

const Id = z.uuid();
const Key = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const PASSED_HEADERS = ['content-type', 'content-disposition'] as const;
const DOWNLOAD_TYPES = /^(application\/zip|application\/json|text\/yaml|text\/plain)(;|$)/;

/**
 * Download of a channel's setup file (a Slack app manifest, the Teams app package): proxies
 * GET /v1/channels/:id/setup-files/:key with the session token. The API checks channels.read, fills the file from
 * the channel's webhook URL and non-secret settings, and builds zip packages. Always an attachment, never rendered.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string; key: string }> }): Promise<Response> {
  const { id, key } = await params;
  if (!Id.safeParse(id).success || !Key.safeParse(key).success) return Response.json({ error: { code: 'invalid_setup_file', message: 'Unknown setup file' } }, { status: 400 });
  const token = await readSessionToken();
  if (!token) return Response.json({ error: { code: 'unauthenticated', message: 'Sign in again' } }, { status: 401 });
  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}/v1/channels/${id}/setup-files/${key}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(30_000) });
  } catch {
    return Response.json({ error: { code: 'unreachable', message: 'The OCSO API could not be reached' } }, { status: 502 });
  }
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || !DOWNLOAD_TYPES.test(type)) {
    return new Response(await res.text(), { status: res.ok ? 502 : res.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
  const headers = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  for (const name of PASSED_HEADERS) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.get('content-disposition')?.startsWith('attachment')) headers.set('content-disposition', 'attachment');
  return new Response(await res.arrayBuffer(), { status: 200, headers });
}
