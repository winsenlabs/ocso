import catalog from './capabilities.generated.json' with { type: 'json' };
import type { InternalRisk } from '../contract.js';

/**
 * The Ask OCSO capability catalog (PM/research/12 §3): every API route a
 * signed-in person can use, generated from the controllers by
 * `pnpm capabilities:generate` (scripts/capabilities) and checked for
 * staleness by test/capabilities.test.ts. The model never sees this list; it
 * searches it through `get_tools` and runs entries through `execute_tool`.
 */

/** A JSON Schema object (draft 2020-12), as produced by `z.toJSONSchema(schema, { io: 'input' })`. */
export type JsonSchema = Record<string, unknown>;

export type HttpCapabilityMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/** `INSIGHT`: an internal-agent insight tool run in-process; `UI`: `ui.open_page`, a link card. */
export type CapabilityMethod = HttpCapabilityMethod | 'INSIGHT' | 'UI';

export interface CapabilityPermissions {
  /** `all`: every listed permission; `any`: at least one. An empty list means any signed-in user (the service scopes). */
  mode: 'all' | 'any';
  list: string[];
}

export interface CapabilityInput {
  params?: JsonSchema;
  query?: JsonSchema;
  /** Without the `approval` field (the confirmation card adds it) and without credential fields (see `secretInputs`). */
  body?: JsonSchema;
}

export interface Capability {
  /** Stable tool name, `<module>.<verb>_<object>`, e.g. `agents.update_agent`, `approvals.list_approvals`. */
  name: string;
  method: CapabilityMethod;
  /** `/v1/agents/:id` for HTTP routes; `insight:<tool>` / `ui:open_page` otherwise. */
  path: string;
  permissions: CapabilityPermissions;
  /** One line: what a person gets done with it. */
  summary: string;
  /** The handler's doc comment (developer detail: status codes, scoping, approval behaviour). */
  details?: string;
  risk: InternalRisk;
  /** Pause / disable / revoke / reduce: applies at once, never an approval. */
  stop?: boolean;
  /** The route is a stop only for these body values (e.g. `{ status: 'PAUSED' }`); other values follow `approvalKind`. */
  stopWhen?: Record<string, unknown>;
  /** Approval descriptor kind when the route can answer 202 `{ proposal }` / 409 approval_required. */
  approvalKind?: string;
  /** Credential fields the route accepts that were removed from `input.body`: they are entered in the UI, never through the model. */
  secretInputs?: string[];
  /**
   * Response fields (dotted paths; arrays are walked) that can carry a credential or sign-in link, e.g.
   * `onboarding.link`. The runtime removes them with `redactResult` before a result reaches the thread or model.
   */
  redactResponse?: string[];
  input: CapabilityInput;
  /** Nouns and synonyms for search. */
  tags: string[];
  /** Web page for the object, with the API route's `:param` names, e.g. `/agents/:id`. */
  uiHref?: string;
}

export interface ExcludedRoute {
  route: string;
  handler: string;
  reason: string;
}

export interface CapabilityCatalog {
  version: 1;
  /** Signed-in web pages (`/agents/:id` patterns): what `ui.open_page` may link to. */
  appRoutes: string[];
  capabilities: Capability[];
  /** API routes deliberately left out, with the reason (auth, streams, uploads, credentials…). */
  excluded: ExcludedRoute[];
}

export const CAPABILITY_CATALOG = catalog as CapabilityCatalog;
export const CAPABILITIES: readonly Capability[] = CAPABILITY_CATALOG.capabilities;
export const APP_ROUTES: readonly string[] = CAPABILITY_CATALOG.appRoutes;

const BY_NAME = new Map(CAPABILITIES.map((c) => [c.name, c]));

export function capabilityByName(name: string): Capability | undefined {
  return BY_NAME.get(name);
}

/** Whether a capability changes something (and so is always a confirmation card). */
export function isWriteCapability(capability: Capability): boolean {
  return capability.risk !== 'READ';
}

/**
 * Whether these arguments make the call a stop (applies at once, never an approval). A `stopWhen` route is a
 * stop only when the body is exactly the stop values: any other field (a rename, a role, settings…) makes it a
 * mixed edit the server may propose, so it is not a stop. `approval` and undefined fields are ignored.
 */
export function isStopCall(capability: Capability, body: Record<string, unknown> | undefined): boolean {
  if (capability.stop) return true;
  if (!capability.stopWhen || !body) return false;
  const stopWhen = capability.stopWhen;
  const keys = Object.keys(body).filter((key) => key !== 'approval' && body[key] !== undefined);
  return keys.length > 0 && keys.length === Object.keys(stopWhen).length && keys.every((key) => Object.hasOwn(stopWhen, key) && body[key] === stopWhen[key]);
}

/**
 * A route's result without its `redactResponse` fields (a deep copy; the input is untouched). Arrays are walked,
 * so `items.link` drops `link` from every item. The runtime applies it to every HTTP result before trimming.
 */
export function redactResult<T>(capability: Capability, data: T): T {
  const paths = capability.redactResponse;
  if (!paths?.length || data === null || typeof data !== 'object') return data;
  const copy = structuredClone(data);
  for (const path of paths) drop(copy, path.split('.'));
  return copy;
}

function drop(node: unknown, path: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) drop(item, path);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const [head, ...rest] = path;
  if (head === undefined) return;
  const record = node as Record<string, unknown>;
  if (rest.length === 0) delete record[head];
  else drop(record[head], rest);
}

/** Whether a principal holding `permissions` may use the capability (the runtime checks with `can` on the principal). */
export function capabilityAllowed(capability: Capability, has: (permission: string) => boolean): boolean {
  const { mode, list } = capability.permissions;
  if (list.length === 0) return true;
  return mode === 'all' ? list.every(has) : list.some(has);
}

/**
 * Whether a path parameter value is a safe single segment: never `.` or `..` (which URL normalisation turns into
 * another route, e.g. `/v1/channels/<id>/templates/..` → `/v1/channels/<id>/`), and never containing a slash.
 */
export function isSafePathValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const text = String(value);
  return text !== '' && text !== '.' && text !== '..' && !/[/\\]/.test(text) && !/^(%2e|\.){1,2}$/i.test(text);
}

/**
 * Fill an API path or page pattern with arguments: `/v1/agents/:id` + `{ id }` → `/v1/agents/<id>`.
 * Values are URI-encoded; a missing or unsafe parameter (`.`, `..`, a slash) returns null, and so does a filled path
 * that URL normalisation would change: the path sent is always the route the card or read names.
 */
export function fillPath(pattern: string, params: Record<string, unknown>): string | null {
  let missing = false;
  const filled = pattern.replace(/:(\w+)/g, (_, key: string) => {
    const value = params[key];
    if (!isSafePathValue(value)) {
      missing = true;
      return '';
    }
    return encodeURIComponent(String(value));
  });
  if (missing) return null;
  return new URL(filled, 'http://ocso.invalid').pathname === filled ? filled : null;
}

/** Whether `href` (a path, no origin) is one of the app's pages: `ui.open_page` refuses anything else. */
export function isAppRoute(href: string): boolean {
  const path = href.split(/[?#]/)[0] ?? '';
  if (!path.startsWith('/') || path.startsWith('//')) return false;
  const segments = path.split('/').filter(Boolean);
  return APP_ROUTES.some((route) => {
    const parts = route.split('/').filter(Boolean);
    return parts.length === segments.length && parts.every((p, i) => p.startsWith(':') ? /^[\w-]+$/.test(segments[i] ?? '') : p === segments[i]);
  });
}
