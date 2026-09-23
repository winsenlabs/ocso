/**
 * Audit log URL model and before/after diff (docs/15 §7). Pure and client-safe.
 * Many entries record the full row as `before` and only the submitted patch as
 * `after`, so a key missing from `after` means "not part of this change", not
 * "removed".
 */

export const AUDIT_VIA = ['UI', 'API', 'INTERNAL_AGENT', 'SYSTEM'] as const;

/** Target types written by the application today (packages/application recordAudit calls). */
export const TARGET_TYPES = [
  'worker_settings',
  'deployment',
  'model_provider',
  'model_profile',
  'model_pricing',
  'mcp_connection',
  'channel',
  'user',
  'team',
  'alert',
  'alert_rule',
  'notification_destination',
  'webhook_subscription',
  'secret',
  'conversation',
  'virtual_agent',
  'prompt_version',
  'queue',
  'sla_policy',
  'approval',
  'audit_store',
] as const;

export interface AuditParams {
  targetType?: string | undefined;
  action?: string | undefined;
  via?: (typeof AUDIT_VIA)[number] | undefined;
  actorId?: string | undefined;
  targetId?: string | undefined;
  /** yyyy-mm-dd (UTC day). */
  from?: string | undefined;
  to?: string | undefined;
  /** ISO timestamp: rows strictly older (keyset page). */
  before?: string | undefined;
  /** Id of the last row shown, so rows sharing its timestamp are not skipped. */
  beforeId?: string | undefined;
  entry?: string | undefined;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SAFE = /^[\w.:-]{1,100}$/;

function first(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.trim() ? s.trim() : undefined;
}

export function parseAuditParams(raw: Record<string, string | string[] | undefined>): AuditParams {
  const via = first(raw['via'])?.toUpperCase();
  const before = first(raw['before']);
  const from = first(raw['from']);
  const to = first(raw['to']);
  const safe = (v: string | undefined) => (v && SAFE.test(v) ? v : undefined);
  return {
    targetType: safe(first(raw['targetType'])),
    action: safe(first(raw['action'])),
    via: AUDIT_VIA.find((v) => v === via),
    actorId: safe(first(raw['actorId'])),
    targetId: safe(first(raw['targetId'])),
    from: from && DAY.test(from) ? from : undefined,
    to: to && DAY.test(to) ? to : undefined,
    before: before && !Number.isNaN(Date.parse(before)) ? new Date(before).toISOString() : undefined,
    beforeId: safe(first(raw['beforeId'])),
    entry: safe(first(raw['entry'])),
  };
}

export function auditHref(p: AuditParams): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (typeof v === 'string' && v) q.set(k, v);
  const qs = q.toString();
  return qs ? `/audit?${qs}` : '/audit';
}

/** URL filters → GET /v1/audit query (dates are whole UTC days; `before` pages). */
export function toApiFilter(p: AuditParams, limit: number) {
  const toEnd = p.to ? new Date(Date.parse(`${p.to}T00:00:00Z`) + 86_400_000).toISOString() : undefined;
  const before = [p.before, toEnd].filter((v): v is string => Boolean(v)).sort()[0];
  // The id tiebreak applies only when the page cursor (not the date filter) is the effective bound.
  const beforeId = p.before && before === p.before ? p.beforeId : undefined;
  return {
    targetType: p.targetType,
    action: p.action,
    via: p.via,
    actorId: p.actorId,
    targetId: p.targetId,
    since: p.from ? new Date(`${p.from}T00:00:00Z`).toISOString() : undefined,
    before,
    beforeId,
    limit,
  };
}

export type DiffChange = 'changed' | 'added' | 'removed' | 'same' | 'context';

export interface DiffRow {
  path: string;
  before: string | null;
  after: string | null;
  change: DiffChange;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function flatten(value: unknown, prefix: string, depth: number, out: Map<string, unknown>): void {
  if (isObject(value) && depth < 3 && Object.keys(value).length) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, depth + 1, out);
    return;
  }
  out.set(prefix || '(value)', value);
}

function show(v: unknown): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/**
 * Field-level diff. When `after` is a partial patch (every after key exists in
 * before), keys only in `before` are context ("not part of this change");
 * otherwise they were removed.
 */
export function diffRows(before: unknown, after: unknown): DiffRow[] {
  const b = new Map<string, unknown>();
  const a = new Map<string, unknown>();
  if (before !== null && before !== undefined) flatten(before, '', 0, b);
  if (after !== null && after !== undefined) flatten(after, '', 0, a);
  const patch = a.size > 0 && b.size > 0 && [...a.keys()].every((k) => b.has(k)) && a.size < b.size;
  const rows: DiffRow[] = [];
  for (const path of new Set([...b.keys(), ...a.keys()])) {
    const inB = b.has(path);
    const inA = a.has(path);
    const bv = inB ? show(b.get(path)) : null;
    const av = inA ? show(a.get(path)) : null;
    let change: DiffChange;
    if (inB && inA) change = bv === av ? 'same' : 'changed';
    else if (inA) change = 'added';
    else change = patch ? 'context' : 'removed';
    rows.push({ path, before: bv, after: av, change });
  }
  const order: Record<DiffChange, number> = { changed: 0, added: 1, removed: 2, same: 3, context: 4 };
  return rows.sort((x, y) => order[x.change] - order[y.change] || x.path.localeCompare(y.path));
}
