import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { PageHead } from '@/components/ui/page-head';
import { hasPermission, requireSession } from '@/lib/session';
import { connectionsHref } from './url';

export const PAGE_TITLE = 'Connections & models';
export const PAGE_SUB = 'Everything OCSO talks to. Credentials are stored by reference; the model never receives them.';

/** Page head with the design's two primary actions, shown only to roles that can use them. */
export async function ConnectionsHead() {
  const session = await requireSession();
  const profile = hasPermission(session, Permission.MODEL_PROFILES_MANAGE);
  const mcp = hasPermission(session, Permission.MCP_MANAGE);
  const actions =
    profile || mcp ? (
      <>
        {profile ? (
          <Link className="btn" href={connectionsHref({ tab: 'providers', dialog: 'profile-new' })} scroll={false}>
            New model profile
          </Link>
        ) : null}
        {mcp ? (
          <Link className="btn accent" href={connectionsHref({ tab: 'mcp', dialog: 'mcp-new' })} scroll={false}>
            Add MCP server
          </Link>
        ) : null}
      </>
    ) : undefined;
  return <PageHead title={PAGE_TITLE} sub={PAGE_SUB} actions={actions} />;
}
