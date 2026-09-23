/**
 * What went wrong with an Ask OCSO request, in terms the drawer can act on.
 * Errors arrive either as an HTTP failure before streaming (the AI SDK's
 * APICallError: `statusCode` + `responseBody`, our route's JSON error) or as
 * an `error` chunk mid-stream (a plain Error whose message the API already
 * made safe to show).
 */

export type ChatProblem =
  | { kind: 'not_configured' }
  | { kind: 'signed_out' }
  | { kind: 'forbidden'; message: string }
  | { kind: 'offline' }
  | { kind: 'failed'; message: string };

const GENERIC = 'Ask OCSO could not answer right now.';

interface HttpLikeError {
  statusCode?: unknown;
  responseBody?: unknown;
}

function apiError(body: unknown): { code?: string; message?: string } {
  if (typeof body !== 'string' || !body.trim().startsWith('{')) return {};
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; message?: unknown } };
    return {
      ...(typeof parsed.error?.code === 'string' ? { code: parsed.error.code } : {}),
      ...(typeof parsed.error?.message === 'string' ? { message: parsed.error.message } : {}),
    };
  } catch {
    return {};
  }
}

export function classifyChatError(error: unknown): ChatProblem {
  if (!(error instanceof Error)) return { kind: 'failed', message: GENERIC };
  const http = error as Error & HttpLikeError;
  if (typeof http.statusCode === 'number') {
    const { code, message } = apiError(http.responseBody);
    if (code === 'internal_agent_not_configured') return { kind: 'not_configured' };
    if (http.statusCode === 401) return { kind: 'signed_out' };
    if (http.statusCode === 403) return { kind: 'forbidden', message: message ?? 'Your role cannot use Ask OCSO.' };
    if (http.statusCode === 503 || http.statusCode === 504) return { kind: 'offline' };
    return { kind: 'failed', message: message ?? GENERIC };
  }
  if (error.name === 'TypeError' && /fetch|network/i.test(error.message)) return { kind: 'offline' };
  // SDK-internal failures (e.g. a data part that failed validation) are not user-facing text.
  if (error.name.startsWith('AI_')) return { kind: 'failed', message: GENERIC };
  // Mid-stream `error` chunk: the API sends only safe, user-facing text.
  return { kind: 'failed', message: error.message.trim() || GENERIC };
}
