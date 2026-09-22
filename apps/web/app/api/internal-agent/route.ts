import { Permission } from '@ocso/auth';
import { getSession } from '@/lib/session';

/**
 * Placeholder for the internal OCSO agent (docs/12). Authenticates the caller
 * like the real endpoint will, then answers 501 so the drawer can say the
 * agent is not available yet. Replace with an SSE proxy to the API.
 */
export async function POST(): Promise<Response> {
  const session = await getSession();
  if (!session) {
    return Response.json({ error: { category: 'authentication', code: 'unauthenticated', message: 'Sign in required' } }, { status: 401 });
  }
  if (!session.permissions.has(Permission.INTERNAL_AGENT_USE)) {
    return Response.json(
      { error: { category: 'authorization', code: 'forbidden', message: 'Your role cannot use the internal agent' } },
      { status: 403 },
    );
  }
  return Response.json(
    { error: { category: 'internal', code: 'not_implemented', message: 'The internal OCSO agent is not available yet.' } },
    { status: 501 },
  );
}
