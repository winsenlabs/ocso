/**
 * The page the user has open when asking (design/05 "context · …"). Sent
 * with each question so "this conversation" resolves; the API only treats it
 * as a hint and every tool still checks access.
 */

export interface PageContext {
  path: string;
  conversationId?: string;
  agentId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Same character set the API accepts for `context.path`. */
const SAFE_PATH = /^\/[A-Za-z0-9/_\-.~%]*$/;

export function pageContext(pathname: string): PageContext {
  const path = SAFE_PATH.test(pathname) && pathname.length <= 300 ? pathname : '/';
  const [area, id] = path.split('/').filter(Boolean);
  const context: PageContext = { path };
  if (id && UUID.test(id)) {
    if (area === 'conversations') context.conversationId = id.toLowerCase();
    if (area === 'agents') context.agentId = id.toLowerCase();
  }
  return context;
}

/** Short display id, as the rest of OCSO writes it (e.g. conv_9f41ac). */
export function shortId(prefix: string, id: string): string {
  return `${prefix}_${id.replace(/-/g, '').slice(-6)}`;
}

/** "conv_9f41ac" / "agent_1a2b3c" for the context line, when the page is about one object. */
export function contextObjectLabel(context: PageContext): string | null {
  if (context.conversationId) return shortId('conv', context.conversationId);
  if (context.agentId) return shortId('agent', context.agentId);
  return null;
}
