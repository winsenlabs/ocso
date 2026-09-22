import { apiBaseUrl, readSessionToken } from '@/lib/api/client';
import { MAX_CHAT_BODY_BYTES, forwardChat, jsonError } from '../forward';

/**
 * POST /api/internal-agent/chat → POST /v1/internal-agent/chat (docs/12).
 * Same-origin endpoint for the Ask OCSO drawer's useChat transport. The API
 * validates the body and authorizes the user; this only attaches the token
 * and streams the answer back.
 */
export async function POST(request: Request): Promise<Response> {
  const token = await readSessionToken();
  if (!token) return jsonError(401, 'authentication', 'unauthenticated', 'Sign in required');

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_CHAT_BODY_BYTES) {
    return jsonError(413, 'validation', 'payload_too_large', 'The question is too long.');
  }
  return forwardChat({
    apiBaseUrl: apiBaseUrl(),
    token,
    body,
    signal: request.signal,
    correlationId: request.headers.get('x-correlation-id'),
  });
}
