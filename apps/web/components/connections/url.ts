/**
 * Connections & models keeps its dialogs in the URL (`?tab=…&dialog=…&id=…`,
 * `?tab=mcp&connection=…`), so the OAuth callback, reloads and links land on
 * the same view the server renders. Client-safe.
 */
export interface ConnectionsParams {
  tab?: string | undefined;
  dialog?: string | undefined;
  id?: string | undefined;
  kind?: string | undefined;
  /** Model id to pre-fill (pricing dialog opened from "no price"). */
  model?: string | undefined;
  connection?: string | undefined;
  step?: string | undefined;
  /** Webhook delivery status filter. */
  deliveries?: string | undefined;
  /** MCP connections view: shared | mine. */
  view?: string | undefined;
}

export function connectionsHref(params: ConnectionsParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value) query.set(key, value);
  }
  const qs = query.toString();
  return qs ? `/connections?${qs}` : '/connections';
}

/** First string value of a search param. */
export function param(params: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const value = params[key];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first ? first : undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A search param that must be an id (anything else is ignored rather than sent to the API). */
export function idParam(params: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const value = param(params, key);
  return value && UUID.test(value) ? value : undefined;
}
