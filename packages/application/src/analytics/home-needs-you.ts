import { and, asc, eq, gte, inArray, or, sql, type SQL } from 'drizzle-orm';
import { APPROVAL_CHECK_PERMISSIONS, Permission, can, isPermission, permissionInfo, type Principal } from '@ocso/auth';
import { alerts, approvalProposals, type Db } from '@ocso/db';
import { displayId } from '@ocso/domain';
import { approvalScope, mayCheck } from '../approvals/access.js';
import type { ApprovalRegistry } from '../approvals/registry.js';
import { visibleAlertsWhere } from '../alerts/audience.js';
import type { ExceptionReportContent, ExceptionSeverity } from '../exceptions/contract.js';
import { WAITING_STATES, slaAtRiskSql, type HomeFlow } from './home-flow.js';
import type { HomeSetup } from './home-setup.js';
import { flowItems, setupItems } from './home-needs-you-derived.js';
import { at, iso } from './values.js';

export type NeedsYouKind =
  | 'approval_to_decide'
  | 'proposal_returned'
  | 'escalation_waiting'
  | 'sla_at_risk'
  | 'alert'
  | 'exception'
  | 'channel_down'
  | 'provider_down'
  | 'grant_expiring'
  | 'routing_stuck'
  | 'setup';

export type NeedsYouSeverity = 'critical' | 'high' | 'normal';

export interface NeedsYouItem {
  /** Stable per item, e.g. 'approval:<proposalId>'. */
  id: string;
  kind: NeedsYouKind;
  severity: NeedsYouSeverity;
  title: string;
  detail?: string;
  /** ISO: when it started, or when it is due. */
  at: string;
  /** Where to act in the UI. */
  href: string;
  /** A ready question for Ask OCSO. */
  askOcso?: string;
}

export const NEEDS_YOU_MAX = 20;
/** How long a returned, blocked or voided proposal of mine stays on Home. */
export const RETURNED_DAYS = 7;
/** How soon an expiring grant of mine shows. */
export const GRANT_EXPIRY_DAYS = 7;

const RANK: Record<NeedsYouSeverity, number> = { critical: 0, high: 1, normal: 2 };

/** Severity first, then the earliest due / oldest; stable on id. Capped at NEEDS_YOU_MAX. */
export function rankNeedsYou(items: readonly NeedsYouItem[]): NeedsYouItem[] {
  return [...items]
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))
    .slice(0, NEEDS_YOU_MAX);
}

export interface NeedsYouInput {
  principal: Principal;
  now: Date;
  /** Queues served by the principal's teams (Service: the pickup scope). */
  queueIds: readonly string[];
  /** The flow and setup Home reads anyway (a promise lets the other sources start first). */
  flow: HomeFlow | null | Promise<HomeFlow | null>;
  setup: HomeSetup | null | Promise<HomeSetup | null>;
  approvalAgeWarningHours: number;
  registry?: ApprovalRegistry | undefined;
  /** The exception report's live view, scoped to the principal (ExceptionService.live). */
  liveExceptions?: ((principal: Principal) => Promise<{ content: ExceptionReportContent }>) | undefined;
  /** Where a failing source is reported; one source failing never hides the others. */
  onError?: ((source: string, err: unknown) => void) | undefined;
}

const quote = (s: string) => `“${s}”`;
const uuidList = (ids: readonly string[]): SQL => sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`;

/**
 * One ranked "needs you" list (HOME decision 1): only what this person may act
 * on, each source read with the same scope as its own page — approvals by
 * approvalScope and the kind's check permission, alerts by visibleAlertsWhere,
 * conversations by the Service pickup scope (their teams' queues or offered to
 * them), exceptions by the live report's scoping, configuration by the manage
 * permission that fixes it.
 */
export async function needsYou(db: Db, input: NeedsYouInput): Promise<NeedsYouItem[]> {
  const { principal } = input;
  const guard = async (source: string, run: () => Promise<NeedsYouItem[]>): Promise<NeedsYouItem[]> => {
    try {
      return await run();
    } catch (err) {
      input.onError?.(source, err);
      return [];
    }
  };
  const parts = await Promise.all([
    can(principal, Permission.APPROVALS_READ) ? guard('approvals', () => approvalItems(db, input)) : [],
    guard('alerts', () => alertItems(db, principal)),
    can(principal, Permission.CONVERSATIONS_CLAIM) && can(principal, Permission.CONVERSATIONS_READ) ? guard('conversations', () => conversationItems(db, input)) : [],
    can(principal, Permission.PROVIDERS_MANAGE) ? guard('providers', () => providerItems(db)) : [],
    guard('grants', () => grantItems(db, input)),
    can(principal, Permission.EXCEPTIONS_READ) && input.liveExceptions ? guard('exceptions', () => exceptionItems(input)) : [],
  ]);
  const [flow, setup] = await Promise.all([input.flow, input.setup]);
  return rankNeedsYou([...parts.flat(), ...flowItems(input, flow), ...setupItems(input, setup)]);
}

async function approvalItems(db: Db, input: NeedsYouInput): Promise<NeedsYouItem[]> {
  const { principal, now, registry } = input;
  const me = principal.userId;
  const returnedSince = new Date(now.getTime() - RETURNED_DAYS * 86_400_000);
  const rows = await db
    .select({
      id: approvalProposals.id,
      objectKind: approvalProposals.objectKind,
      title: approvalProposals.title,
      status: approvalProposals.status,
      makerId: approvalProposals.makerId,
      checkerId: approvalProposals.checkerId,
      submittedAt: approvalProposals.submittedAt,
      decidedAt: approvalProposals.decidedAt,
      updatedAt: approvalProposals.updatedAt,
      decisionReason: approvalProposals.decisionReason,
      blockedReason: approvalProposals.blockedReason,
    })
    .from(approvalProposals)
    .where(
      and(
        approvalScope(principal) ?? undefined,
        or(
          and(eq(approvalProposals.status, 'SUBMITTED'), eq(approvalProposals.checkerId, me)),
          and(
            eq(approvalProposals.makerId, me),
            inArray(approvalProposals.status, ['REJECTED', 'BLOCKED', 'VOID']),
            gte(sql`COALESCE(${approvalProposals.decidedAt}, ${approvalProposals.updatedAt})`, returnedSince),
          ),
        ),
      ),
    )
    .orderBy(asc(approvalProposals.submittedAt))
    .limit(60);
  const warnAfterMs = input.approvalAgeWarningHours * 3_600_000;
  const holdsCheck = APPROVAL_CHECK_PERMISSIONS.some((p) => can(principal, p));
  const items: NeedsYouItem[] = [];
  for (const p of rows) {
    const label = registry?.has(p.objectKind) ? registry.get(p.objectKind).label : p.objectKind.replace(/_/g, ' ');
    if (p.status === 'SUBMITTED') {
      // Only proposals this person may decide: the named checker holding the kind's check permission, not the maker.
      const decidable = registry?.has(p.objectKind) ? mayCheck(principal, registry.get(p.objectKind), p) : holdsCheck && p.makerId !== me;
      if (!decidable) continue;
      const old = now.getTime() - p.submittedAt.getTime() > warnAfterMs;
      items.push({
        id: `approval:${p.id}`,
        kind: 'approval_to_decide',
        severity: old ? 'high' : 'normal',
        title: `Approve or reject: ${p.title}`,
        detail: `${label} change waiting on you${old ? ` for more than ${input.approvalAgeWarningHours} h` : ''}`,
        at: p.submittedAt.toISOString(),
        href: `/approvals?approval=${p.id}`,
        askOcso: `Review the proposal ${quote(p.title)} waiting on me: what changes, and what should I check before deciding?`,
      });
    } else {
      const verb = p.status === 'REJECTED' ? 'was rejected' : p.status === 'BLOCKED' ? 'could not be applied' : 'was voided';
      const reason = p.status === 'BLOCKED' ? p.blockedReason : p.decisionReason;
      items.push({
        id: `proposal:${p.id}`,
        kind: 'proposal_returned',
        severity: p.status === 'BLOCKED' ? 'high' : 'normal',
        title: `Your change ${verb}: ${p.title}`,
        ...(reason ? { detail: reason } : { detail: `${label} change` }),
        at: (p.decidedAt ?? p.updatedAt).toISOString(),
        href: `/approvals?box=sent&approval=${p.id}`,
        askOcso:
          p.status === 'REJECTED'
            ? `Why was my proposal ${quote(p.title)} rejected, and what should I change?`
            : p.status === 'BLOCKED'
              ? `Why could my approved proposal ${quote(p.title)} not be applied, and what should I do?`
              : `Why was my proposal ${quote(p.title)} voided, and what should I do next?`,
      });
    }
  }
  return items;
}

async function alertItems(db: Db, principal: Principal): Promise<NeedsYouItem[]> {
  const rows = await db
    .select({ id: alerts.id, title: alerts.title, severity: alerts.severity, status: alerts.status, kind: alerts.kind, openedAt: alerts.openedAt, value: alerts.value })
    .from(alerts)
    .where(and(inArray(alerts.status, ['OPEN', 'ACKNOWLEDGED']), visibleAlertsWhere(principal)))
    .orderBy(sql`(${alerts.severity} = 'CRITICAL') DESC`, asc(alerts.openedAt))
    .limit(10);
  return rows.map((a) => {
    const acknowledged = a.status === 'ACKNOWLEDGED';
    const base: NeedsYouSeverity = a.severity === 'CRITICAL' ? 'critical' : a.severity === 'WARNING' ? 'high' : 'normal';
    // Someone acknowledged it: still open, one step less urgent.
    const severity: NeedsYouSeverity = acknowledged ? (base === 'critical' ? 'high' : 'normal') : base;
    return {
      id: `alert:${a.id}`,
      kind: 'alert' as const,
      severity,
      title: a.title,
      detail: [a.kind === 'TECHNICAL' ? 'Technical alert' : 'Business alert', acknowledged ? 'acknowledged' : null, a.value].filter(Boolean).join(' · '),
      at: a.openedAt.toISOString(),
      href: `/alerts?alert=${a.id}`,
      askOcso: `Explain the alert ${quote(a.title)} and what I should do about it.`,
    };
  });
}

/**
 * Conversations offered to me, and (Service) unassigned ones waiting in my teams' queues (the pickup queue's
 * scope). One item per conversation: an SLA at or past its at-risk point outranks plain waiting.
 */
async function conversationItems(db: Db, input: NeedsYouInput): Promise<NeedsYouItem[]> {
  const { principal, now, queueIds } = input;
  const me = principal.userId;
  // Someone who assigns work (a Lead or Head) gets one item per queue from the flow instead; only offers to them come here.
  const pickup = queueIds.length && !can(principal, Permission.CONVERSATIONS_ASSIGN);
  const inMyQueues = pickup ? sql`(c.assigned_user_id IS NULL AND c.queue_id = ANY(${uuidList(queueIds)}))` : sql`false`;
  const { rows } = await db.execute<{
    id: string; priority: string; waiting_since: Date | string | null; sla_due_at: Date | string | null; assigned_user_id: string | null;
    customer_name: string | null; queue_name: string | null; at_risk: boolean;
  }>(sql`
    SELECT c.id, c.priority, c.waiting_since, c.sla_due_at, c.assigned_user_id, cu.display_name AS customer_name, q.name AS queue_name,
           ${slaAtRiskSql(now)} AS at_risk
      FROM conversations c
      JOIN customers cu ON cu.id = c.customer_id
      LEFT JOIN queues q ON q.id = c.queue_id
      LEFT JOIN sla_policies sp ON sp.id = q.sla_policy_id
     WHERE c.control_state IN ${WAITING_STATES} AND (c.assigned_user_id = ${me}::uuid OR ${inMyQueues})
     ORDER BY c.sla_due_at NULLS LAST, c.priority, c.waiting_since NULLS LAST
     LIMIT ${NEEDS_YOU_MAX}`);
  return rows.map((r) => {
    const who = r.customer_name ?? 'A customer';
    const offered = r.assigned_user_id === me;
    const due = r.sla_due_at ? new Date(r.sla_due_at) : null;
    const since = iso(r.waiting_since) ?? now.toISOString();
    const where = [r.queue_name, r.priority].filter(Boolean).join(' · ');
    const ask = `Summarise conversation ${displayId('conv', r.id)} before I pick it up.`;
    if (r.at_risk && due) {
      const breached = due.getTime() <= now.getTime();
      return {
        id: `conversation:${r.id}`,
        kind: 'sla_at_risk' as const,
        severity: breached ? ('critical' as const) : ('high' as const),
        title: `${who}: SLA ${breached ? 'breached' : 'at risk'}`,
        detail: `${offered ? 'Offered to you' : 'Waiting'}${where ? ` · ${where}` : ''}`,
        at: due.toISOString(),
        href: `/conversations/${r.id}`,
        askOcso: ask,
      };
    }
    return {
      id: `conversation:${r.id}`,
      kind: 'escalation_waiting' as const,
      severity: offered || r.priority === 'P1' ? ('high' as const) : ('normal' as const),
      title: offered ? `${who} is waiting for you` : `${who} is waiting${r.queue_name ? ` in ${r.queue_name}` : ''}`,
      ...(where ? { detail: where } : {}),
      at: due ? due.toISOString() : since,
      href: `/conversations/${r.id}`,
      askOcso: ask,
    };
  });
}

async function providerItems(db: Db): Promise<NeedsYouItem[]> {
  const { rows } = await db.execute<{ id: string; name: string; status: string; last_error: string | null; last_health_at: Date | string | null; updated_at: Date | string }>(sql`
    SELECT id, name, status, last_error, last_health_at, updated_at FROM model_providers
     WHERE enabled AND status IN ('DOWN', 'DEGRADED') ORDER BY name`);
  return rows.map((p) => ({
    id: `provider:${p.id}`,
    kind: 'provider_down' as const,
    severity: p.status === 'DOWN' ? ('critical' as const) : ('high' as const),
    title: `Model provider ${p.name} is ${p.status === 'DOWN' ? 'down' : 'degraded'}`,
    ...(p.last_error ? { detail: p.last_error.slice(0, 200) } : {}),
    at: iso(p.last_health_at ?? p.updated_at)!,
    href: '/connections?tab=providers',
    askOcso: `What is wrong with the model provider ${quote(p.name)} and which agents does it affect?`,
  }));
}

async function grantItems(db: Db, input: NeedsYouInput): Promise<NeedsYouItem[]> {
  const { principal, now } = input;
  const until = new Date(now.getTime() + GRANT_EXPIRY_DAYS * 86_400_000);
  const { rows } = await db.execute<{ id: string; permission: string; expires_at: Date | string }>(sql`
    SELECT id, permission, expires_at FROM user_permission_grants
     WHERE user_id = ${principal.userId}::uuid AND effect = 'GRANT' AND cleared_at IS NULL
       AND expires_at > ${at(now)} AND expires_at <= ${at(until)}
     ORDER BY expires_at`);
  return rows.map((g) => {
    const expires = new Date(g.expires_at);
    const name = isPermission(g.permission) ? permissionInfo(g.permission).label : g.permission;
    return {
      id: `grant:${g.id}`,
      kind: 'grant_expiring' as const,
      severity: expires.getTime() - now.getTime() <= 86_400_000 ? ('high' as const) : ('normal' as const),
      title: `Your extra access “${name}” expires soon`,
      detail: `Granted until ${expires.toISOString()}; ask a Head to extend it if you still need it.`,
      at: expires.toISOString(),
      href: can(principal, Permission.USERS_READ) ? `/team?user=${principal.userId}` : '/account/security',
      askOcso: `My “${name}” access expires soon: what will I lose, and who can extend it?`,
    };
  });
}

const EXCEPTION_SEVERITY: Record<ExceptionSeverity, NeedsYouSeverity> = { critical: 'critical', high: 'high', medium: 'normal', low: 'normal' };

async function exceptionItems(input: NeedsYouInput): Promise<NeedsYouItem[]> {
  const { content } = await input.liveExceptions!(input.principal);
  return content.sections
    .filter((s) => !s.error && s.total > 0 && s.severity !== 'low')
    .map((s) => {
      const latest = s.items.reduce<string | null>((m, i) => (m === null || i.occurredAt > m ? i.occurredAt : m), null);
      return {
        id: `exception:${s.id}`,
        kind: 'exception' as const,
        severity: EXCEPTION_SEVERITY[s.severity],
        title: `${s.label}: ${s.total}`,
        detail: s.description,
        at: latest ?? input.now.toISOString(),
        href: '/exceptions',
        askOcso: `Walk me through the live exceptions for ${quote(s.label)} and what I should do.`,
      };
    });
}
