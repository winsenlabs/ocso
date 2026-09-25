/**
 * Old URLs that moved in the information-architecture pass, answered by
 * proxy.ts with a permanent redirect so bookmarks, alert e-mails and audit
 * links keep working. Edge-safe (no imports).
 */

/**
 * `/connections?tab=mine` (the old "My connections" tab and sidebar entry) is
 * now the "My connections" view of MCP connections. Every other parameter
 * (connection, oauth…) is kept. Null when the URL is current.
 */
export function legacyRedirect(pathname: string, search: URLSearchParams): string | null {
  if (pathname === '/connections' && search.get('tab') === 'mine') {
    const next = new URLSearchParams(search);
    next.set('tab', 'mcp');
    next.set('view', 'mine');
    return `/connections?${next.toString()}`;
  }
  return null;
}
