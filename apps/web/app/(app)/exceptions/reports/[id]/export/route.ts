import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiBaseUrl, readSessionToken } from '@/lib/api/client';

const Id = z.uuid();

/**
 * Download of a signed exception report export (exceptions.sign): streams the
 * zip from GET /v1/exceptions/reports/:id/export with the session token. The
 * API authorizes and audits the export.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!Id.safeParse(id).success) return Response.json({ error: { code: 'invalid_report', message: 'Unknown report' } }, { status: 400 });
  const token = await readSessionToken();
  if (!token) return Response.json({ error: { code: 'unauthenticated', message: 'Sign in again' } }, { status: 401 });
  try {
    const res = await fetch(`${apiBaseUrl()}/v1/exceptions/reports/${id}/export`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return new Response(await res.text(), { status: res.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    const headers = new Headers({ 'content-type': 'application/zip', 'cache-control': 'no-store' });
    const disposition = res.headers.get('content-disposition');
    if (disposition) headers.set('content-disposition', disposition);
    return new Response(res.body, { status: 200, headers });
  } catch {
    return Response.json({ error: { code: 'unreachable', message: 'The OCSO API could not be reached' } }, { status: 502 });
  }
}
