import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiBaseUrl, readSessionToken } from '@/lib/api/client';
import { crossOriginRejected, isSameOriginRequest } from '@/lib/same-origin';

const Id = z.uuid();
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Browser upload of a staff reply attachment (design/01 composer). Streams the
 * raw file to POST /v1/conversations/:id/attachments with the session token;
 * the API validates it against the conversation channel and stores it.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!isSameOriginRequest(request)) return crossOriginRejected();
  const { id } = await params;
  if (!Id.safeParse(id).success) return Response.json({ error: { code: 'invalid_conversation', message: 'Unknown conversation' } }, { status: 400 });
  const token = await readSessionToken();
  if (!token) return Response.json({ error: { code: 'unauthenticated', message: 'Sign in again' } }, { status: 401 });
  const body = await request.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > MAX_BYTES) return Response.json({ error: { code: 'attachment_rejected', message: 'Files must be between 1 byte and 25 MB' } }, { status: 400 });

  const headers = new Headers({ authorization: `Bearer ${token}`, 'content-type': request.headers.get('content-type') ?? 'application/octet-stream' });
  for (const name of ['x-ocso-content-type', 'x-ocso-filename']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value.slice(0, 300));
  }
  try {
    const res = await fetch(`${apiBaseUrl()}/v1/conversations/${id}/attachments`, { method: 'POST', headers, body, cache: 'no-store', signal: AbortSignal.timeout(60_000) });
    return new Response(await res.text(), { status: res.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch {
    return Response.json({ error: { code: 'unreachable', message: 'The OCSO API could not be reached' } }, { status: 502 });
  }
}
