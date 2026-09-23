import { Permission } from '@ocso/auth';
import type { DrawerState } from '@/components/internal-agent/types';
import { ApiError } from '@/lib/api/errors';
import { internalAgentConfigured, listInternalAgentThreads, listProfileOptions } from '@/lib/api/internal-agent';
import { getSession } from '@/lib/session';
import { jsonError } from './forward';

/**
 * GET /api/internal-agent — what the Ask OCSO drawer needs when it opens:
 * whether a model profile is configured (deployment setting
 * `internalAgentProfileId`), the user's threads, and — for a Tech Admin when
 * nothing is configured yet — the profiles they can choose from.
 */
export async function GET(): Promise<Response> {
  try {
    const session = await getSession();
    if (!session) return jsonError(401, 'authentication', 'unauthenticated', 'Sign in required');
    if (!session.permissions.has(Permission.INTERNAL_AGENT_USE)) {
      return jsonError(403, 'authorization', 'forbidden', 'Your role cannot use Ask OCSO.');
    }
    const [configured, threads] = await Promise.all([internalAgentConfigured(), listInternalAgentThreads()]);
    const canConfigure = session.permissions.has(Permission.DEPLOYMENT_SETTINGS_MANAGE);
    const profiles = !configured && canConfigure ? await listProfileOptions() : null;
    return Response.json({ configured, threads, profiles } satisfies DrawerState);
  } catch (err) {
    if (err instanceof ApiError) return jsonError(err.status, err.category, err.code, err.message);
    return jsonError(500, 'internal', 'internal', 'Ask OCSO could not load.');
  }
}
