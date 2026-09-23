import { Permission } from '@ocso/auth';
import type { DrawerState } from '@/components/internal-agent/types';
import { ApiError } from '@/lib/api/errors';
import { getInternalAgentCapabilities, internalAgentDeployment, listInternalAgentThreads, listProfileOptions } from '@/lib/api/internal-agent';
import { getSession } from '@/lib/session';
import { jsonError } from './forward';

/**
 * GET /api/internal-agent — what the Ask OCSO drawer needs when it opens:
 * whether a model profile is configured (deployment setting
 * `internalAgentProfileId`), the user's threads, and — for a Tech admin when
 * nothing is configured yet — the profiles they can choose from, plus the
 * "What can you do?" chips and per-area answer for this user's permissions
 * (from the capability catalog; null when the API has none, and the drawer
 * uses its own chips and lets the model answer).
 */
export async function GET(): Promise<Response> {
  try {
    const session = await getSession();
    if (!session) return jsonError(401, 'authentication', 'unauthenticated', 'Sign in required');
    if (!session.permissions.has(Permission.INTERNAL_AGENT_USE)) {
      return jsonError(403, 'authorization', 'forbidden', 'Your role cannot use Ask OCSO.');
    }
    const [{ configured, writesOn: deploymentWrites }, threads, capabilities] = await Promise.all([
      internalAgentDeployment(),
      listInternalAgentThreads(),
      // Best effort: a missing or failing endpoint only costs the chips and the catalog answer.
      getInternalAgentCapabilities().catch(() => null),
    ]);
    const suggestions = capabilities?.suggestions.length ? capabilities.suggestions.slice(0, 6) : null;
    const writesOn = capabilities?.writesOn ?? deploymentWrites;
    // With writes off, the drawer offers reads only (the API filters too; an older API may not).
    const areas = capabilities?.areas ? (writesOn ? capabilities.areas : capabilities.areas.flatMap((a) => (a.reads > 0 ? [{ ...a, writes: 0 }] : []))) : null;
    const canConfigure = session.permissions.has(Permission.DEPLOYMENT_SETTINGS_MANAGE);
    const profiles = !configured && canConfigure ? await listProfileOptions() : null;
    return Response.json({ configured, threads, profiles, suggestions, areas, writesOn } satisfies DrawerState);
  } catch (err) {
    if (err instanceof ApiError) return jsonError(err.status, err.category, err.code, err.message);
    return jsonError(500, 'internal', 'internal', 'Ask OCSO could not load.');
  }
}
