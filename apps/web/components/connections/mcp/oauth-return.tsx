import Link from 'next/link';
import { AlertBanner } from '@/components/ui/alert-banner';
import { getConnection, type Connection } from '@/lib/api/mcp';
import { connectionsHref, idParam, param } from '../url';
import { oauthReasonText, stepForStage } from './meta';

/**
 * Return leg of the OAuth 2.1 flow (ADR-021): the public callback redirects
 * to /connections?tab=mcp&connection=<id>&oauth=ok|error&reason=<code>. Only
 * the id and a stable code travel in the URL; everything else is re-read from
 * the API.
 */
export interface OAuthReturn {
  ok: boolean;
  reason: string | undefined;
  connectionId: string | undefined;
  connection: Pick<Connection, 'name' | 'stage' | 'status' | 'lastError' | 'tools' | 'kind' | 'approvedAt'> | null;
  /** A personal connection (shown on "My connections"). */
  personal: boolean;
}

export async function oauthReturnOf(
  params: Record<string, string | string[] | undefined>,
  options: { canReadShared: boolean },
): Promise<OAuthReturn | null> {
  const outcome = param(params, 'oauth');
  if (outcome !== 'ok' && outcome !== 'error') return null;
  const connectionId = idParam(params, 'connection');
  let connection: Connection | null = null;
  if (connectionId) {
    connection = await getConnection(connectionId, options.canReadShared ? 'connections' : 'personal').catch(() => null);
  }
  return {
    ok: outcome === 'ok',
    reason: param(params, 'reason'),
    connectionId,
    connection,
    personal: connection ? connection.kind === 'PERSONAL' : !options.canReadShared,
  };
}

function successText(c: OAuthReturn['connection']): string {
  if (!c) return 'The authorization server granted access. Credentials are in the secret store; OCSO keeps only references.';
  if (c.lastError) return `Tokens were stored, but discovery afterwards failed: ${c.lastError}`;
  if (c.stage === 'REVIEW') return `Tokens stored as secret references. Discovery found ${c.tools.total} tools — review and approve them next.`;
  if (c.stage === 'ACTIVE') return `Tokens stored as secret references. ${c.kind === 'PERSONAL' ? 'Your connection is active' : 'The connection is active'} with ${c.tools.approved} approved tools.`;
  return 'Tokens stored as secret references.';
}

export function OAuthReturnBanner({ result }: { result: OAuthReturn }) {
  const name = result.connection?.name;
  const c = result.connection;
  const step = !result.ok ? 'auth' : c && !c.approvedAt && c.kind !== 'PERSONAL' ? stepForStage(c.stage) : undefined;
  const continueHref = connectionsHref({ tab: 'mcp', view: result.personal ? 'mine' : undefined, connection: result.connectionId, step });
  const action = result.connectionId ? (
    <Link className="btn tiny" href={continueHref} scroll={false}>
      {result.ok ? 'Continue' : 'Try again'}
    </Link>
  ) : null;
  return result.ok ? (
    <AlertBanner title={`Authorization complete${name ? ` for ${name}` : ''}.`} action={action}>
      {successText(result.connection)}
    </AlertBanner>
  ) : (
    <AlertBanner tone="error" title={`Authorization failed${name ? ` for ${name}` : ''}.`} action={action}>
      {oauthReasonText(result.reason)}
    </AlertBanner>
  );
}
