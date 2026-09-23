import { sql } from 'drizzle-orm';
import { Permission } from '@ocso/auth';
import type { ExceptionKind } from '../contract.js';
import { at, idsOf, isoOf, item, plural, rows, teamsOf } from './support.js';

/**
 * Rights that went around approval, customers routing could not place, message
 * templates a provider refused, and deliveries that failed (PM/research/11 §7).
 */

/**
 * A report is immutable evidence: a stored delivery error keeps only its first line, bounded (response
 * bodies and stack text never enter it).
 */
const errorLine = (e: string): string => (e.split(/\r?\n/)[0] ?? '').slice(0, 120);

/** Audit actions that raise someone's access or let them sign in (identity, apply.ts): each needs an approval. */
export const ACCESS_INCREASE_ACTIONS = ['user.permissions_increased', 'user.activate', 'user.enable'] as const;

export const permissionBypass: ExceptionKind = {
  id: 'permission_bypass',
  label: 'Permissions granted without approval',
  severity: 'critical',
  description:
    'Active permission GRANTs whose approval is missing or was never approved, as of generation; and, from the audit trail, every access increase or sign-in enablement in the period that no approval applied (including approvals skipped by the development flag or demo seed).',
  sources: ['audit'],
  async compute(ctx) {
    const grants = await rows<{ id: string; user_id: string; name: string; permission: string; created_at: Date; expires_at: Date | null; reason: string; created_by: string | null; granted_by: string | null; proposal_status: string | null; team_ids: unknown }>(
      ctx.db,
      sql`SELECT g.id, g.user_id, u.name, g.permission, g.created_at, g.expires_at, g.reason, g.created_by, m.name AS granted_by, ap.status AS proposal_status,
                 ARRAY(SELECT tm.team_id FROM team_members tm WHERE tm.user_id = g.user_id ORDER BY tm.team_id) AS team_ids
            FROM user_permission_grants g
            JOIN users u ON u.id = g.user_id
            LEFT JOIN users m ON m.id = g.created_by
            LEFT JOIN approval_proposals ap ON ap.id = g.proposal_id
           WHERE g.effect = 'GRANT' AND g.cleared_at IS NULL
             AND (g.proposal_id IS NULL OR ap.status IS DISTINCT FROM 'APPROVED')
             AND (g.expires_at IS NULL OR g.expires_at > ${at(ctx.now)})
           ORDER BY g.created_at DESC, g.id`,
    );
    const events = await rows<{ id: string; occurred_at: Date; actor_id: string | null; actor_name: string | null; action: string; target_type: string; target_id: string | null; summary: string; skipped: string | null; team_ids: unknown }>(
      ctx.db,
      sql`SELECT a.id, a.occurred_at, a.actor_id, a.actor_name, a.action, a.target_type, a.target_id, a.summary, a.after->>'approvalSkipped' AS skipped, a.team_ids
            FROM audit_events a
           WHERE a.occurred_at >= ${at(ctx.period.start)} AND a.occurred_at < ${at(ctx.period.end)}
             AND (a.after->>'approvalSkipped' IS NOT NULL
                  OR (a.action IN (${sql.join(ACCESS_INCREASE_ACTIONS.map((x) => sql`${x}`), sql`, `)})
                      AND coalesce(a.after->>'proposalId', '') = ''
                      -- Rights edited on a person not yet approved are a draft (inert): their activation is the event.
                      AND (a.action <> 'user.permissions_increased' OR a.before->>'status' = 'ACTIVE')))
           ORDER BY a.occurred_at DESC, a.id`,
    );
    const skippedText = (s: string) => (s === 'demo_seed' ? 'demo seed' : s === 'dev_flag' ? 'development flag' : s);
    return [
      ...grants.map((g) =>
        item({
          objectKind: 'user',
          objectId: g.user_id,
          title: `${g.name} holds ${g.permission} without an approval`,
          detail: `Granted ${isoOf(g.created_at, ctx.now).slice(0, 10)}${g.granted_by ? ` by ${g.granted_by}` : ''}${g.expires_at ? `, until ${isoOf(g.expires_at, ctx.now).slice(0, 10)}` : ''}; ${g.proposal_status ? `its proposal is ${g.proposal_status.toLowerCase()}, not approved` : 'no approval is recorded for it'}. Reason: ${g.reason}`,
          occurredAt: isoOf(g.created_at, ctx.now),
          href: `/team?user=${g.user_id}`,
          teamIds: teamsOf(g.team_ids),
          readableWith: Permission.USERS_READ,
          actorIds: idsOf(g.created_by),
          subjectIds: idsOf(g.user_id),
        }),
      ),
      ...events.map((a) => {
        const person = a.target_type === 'user' ? a.target_id : null;
        return item({
          objectKind: a.target_type,
          objectId: a.target_id,
          title: a.skipped ? `Approval skipped (${skippedText(a.skipped)}): ${a.summary}` : `Access raised without an approval: ${a.summary}`,
          detail: `${a.action} by ${a.actor_name ?? 'the system'}; audit event ${a.id}.`,
          occurredAt: isoOf(a.occurred_at, ctx.now),
          href: person ? `/team?user=${person}` : null,
          teamIds: teamsOf(a.team_ids),
          readableWith: person ? Permission.USERS_READ : null,
          actorIds: idsOf(a.actor_id),
          subjectIds: idsOf(person),
        });
      }),
    ];
  },
};

export const routingFallback: ExceptionKind = {
  id: 'routing_fallback',
  label: 'Routing fell back or was blocked',
  severity: 'medium',
  description:
    'Conversations a router sent to its fallback queue (no rule matched, or the customer did not answer in time), per router and queue; routing that could not place a customer; and customer messages refused because no router was active. In the period, from the conversation timeline and the audit trail.',
  sources: ['conversation', 'audit'],
  async compute(ctx) {
    // Every routing decision is on the conversation's timeline (system.routed): the history, not the latest state.
    const fallbacks = await rows<{ router_id: string | null; router: string | null; queue_id: string | null; queue: string | null; outcome: string; n: number; last: Date; team_ids: unknown }>(
      ctx.db,
      sql`WITH ev AS (
            SELECT p.content->'data'->>'routerId' AS router_id, p.content->'data'->>'queueId' AS queue_id, p.content->'data'->>'outcome' AS outcome, i.created_at
              FROM interactions i JOIN interaction_parts p ON p.interaction_id = i.id
             WHERE i.kind = 'SYSTEM_EVENT' AND i.created_at >= ${at(ctx.period.start)} AND i.created_at < ${at(ctx.period.end)}
               AND p.type = 'STRUCTURED' AND p.content->>'schema' = 'system.routed' AND p.content->'data'->>'outcome' IN ('FALLBACK','TIMEOUT'))
          SELECT ev.router_id, r.name AS router, ev.queue_id, q.name AS queue, ev.outcome, count(*)::int AS n, max(ev.created_at) AS last,
                 ARRAY(SELECT qt.team_id FROM queue_teams qt WHERE qt.queue_id::text = ev.queue_id ORDER BY qt.team_id) AS team_ids
            FROM ev
            LEFT JOIN routers r ON r.id::text = ev.router_id
            LEFT JOIN queues q ON q.id::text = ev.queue_id
           GROUP BY ev.router_id, r.name, ev.queue_id, q.name, ev.outcome
           ORDER BY n DESC, last DESC`,
    );
    const blocked = await rows<{ router_id: string | null; router: string | null; n: number; last: Date }>(
      ctx.db,
      sql`SELECT p.content->'data'->>'routerId' AS router_id, r.name AS router, count(*)::int AS n, max(i.created_at) AS last
            FROM interactions i
            JOIN interaction_parts p ON p.interaction_id = i.id
            LEFT JOIN routers r ON r.id::text = p.content->'data'->>'routerId'
           WHERE i.kind = 'SYSTEM_EVENT' AND i.created_at >= ${at(ctx.period.start)} AND i.created_at < ${at(ctx.period.end)}
             AND p.type = 'STRUCTURED' AND p.content->>'schema' = 'system.routing_blocked'
           GROUP BY 1, 2
           ORDER BY n DESC`,
    );
    const refused = await rows<{ channel_id: string | null; channel: string | null; reason: string | null; n: number; last: Date }>(
      ctx.db,
      sql`SELECT a.target_id AS channel_id, c.name AS channel, a.after->>'reason' AS reason, count(*)::int AS n, max(a.occurred_at) AS last
            FROM audit_events a
            LEFT JOIN channels c ON c.id::text = a.target_id
           WHERE a.action = 'conversation.inbound_rejected' AND a.occurred_at >= ${at(ctx.period.start)} AND a.occurred_at < ${at(ctx.period.end)}
           GROUP BY 1, 2, 3
           ORDER BY n DESC`,
    );
    return [
      ...fallbacks.map((f) =>
        item({
          objectKind: 'router',
          objectId: f.router_id,
          title: `${f.router ?? 'A router'} ${f.outcome === 'TIMEOUT' ? 'timed out' : 'fell back'} to ${f.queue ?? 'its fallback queue'}: ${plural(f.n, 'conversation')}`,
          detail:
            f.outcome === 'TIMEOUT'
              ? 'The customer did not answer the router’s question in time; the fallback queue took the conversation.'
              : 'No rule matched the customer’s answers; the fallback queue took the conversation.',
          occurredAt: isoOf(f.last, ctx.now),
          href: f.router_id ? `/routers/${f.router_id}` : null,
          teamIds: teamsOf(f.team_ids),
          count: f.n,
        }),
      ),
      ...blocked.map((b) =>
        item({
          objectKind: 'router',
          objectId: b.router_id,
          title: `${b.router ?? 'A router'} could not place customers: ${plural(b.n, 'time')}`,
          detail: 'Neither the chosen queue nor the fallback had an AI agent; the conversations waited in routing.',
          occurredAt: isoOf(b.last, ctx.now),
          href: b.router_id ? `/routers/${b.router_id}` : null,
          count: b.n,
        }),
      ),
      ...refused.map((r) =>
        item({
          objectKind: 'channel',
          objectId: r.channel_id,
          title: `${r.channel ?? 'A channel'} refused ${plural(r.n, 'customer message')} (${r.reason ?? 'rejected'})`,
          detail: 'Customers wrote but no conversation could start, so nobody answered them.',
          occurredAt: isoOf(r.last, ctx.now),
          href: '/connections?tab=channels',
          count: r.n,
        }),
      ),
    ];
  },
};

export const templatesRejected: ExceptionKind = {
  id: 'templates_rejected',
  label: 'Message templates rejected',
  severity: 'low',
  description:
    'Message templates the provider rejected: in the live view every template currently rejected; in a report every rejection recorded during the period (from the audit trail), even if the template was fixed or deleted since.',
  sources: ['audit'],
  async compute(ctx) {
    if (ctx.mode === 'REPORT') {
      const found = await rows<{ id: string; target_id: string | null; summary: string; reason: string | null; occurred_at: Date; name: string | null; language: string | null; channel: string | null }>(
        ctx.db,
        sql`SELECT a.id, a.target_id, a.summary, a.after->>'rejectionReason' AS reason, a.occurred_at, t.name, t.language, c.name AS channel
              FROM audit_events a
              LEFT JOIN message_templates t ON t.id::text = a.target_id
              LEFT JOIN channels c ON c.id = t.channel_id
             WHERE a.action = 'message_template.status_changed' AND a.after->>'status' = 'REJECTED'
               AND a.occurred_at >= ${at(ctx.period.start)} AND a.occurred_at < ${at(ctx.period.end)}
             ORDER BY a.occurred_at DESC, a.id`,
      );
      return found.map((r) =>
        item({
          objectKind: 'message_template',
          objectId: r.target_id,
          title: r.name ? `Template ${r.name} (${r.language}) rejected${r.channel ? ` on ${r.channel}` : ''}` : r.summary,
          detail: r.reason ? `Provider reason: ${r.reason}` : 'The provider gave no reason.',
          occurredAt: isoOf(r.occurred_at, ctx.now),
          href: '/templates',
        }),
      );
    }
    const found = await rows<{ id: string; name: string; language: string; channel: string | null; reason: string | null; changed: Date | null; updated_at: Date }>(
      ctx.db,
      sql`SELECT t.id, t.name, t.language, c.name AS channel, t.rejection_reason AS reason, t.status_changed_at AS changed, t.updated_at
            FROM message_templates t LEFT JOIN channels c ON c.id = t.channel_id
           WHERE t.status = 'REJECTED' AND t.deleted_at IS NULL
           ORDER BY coalesce(t.status_changed_at, t.updated_at) DESC, t.id`,
    );
    return found.map((t) =>
      item({
        objectKind: 'message_template',
        objectId: t.id,
        title: `Template ${t.name} (${t.language}) rejected${t.channel ? ` on ${t.channel}` : ''}`,
        detail: t.reason ? `Provider reason: ${t.reason}` : 'The provider gave no reason.',
        occurredAt: isoOf(t.changed ?? t.updated_at, ctx.now),
        href: '/templates',
      }),
    );
  },
};

export const deliveryFailures: ExceptionKind = {
  id: 'delivery_failures',
  label: 'Delivery failures',
  severity: 'medium',
  description: 'Outbound customer messages, webhook deliveries and alert notifications that failed in the period, grouped by channel, subscription or destination and error.',
  sources: ['conversation', 'operational'],
  async compute(ctx) {
    const messages = await rows<{ channel_id: string | null; channel: string | null; error: string | null; n: number; last: Date }>(
      ctx.db,
      sql`SELECT i.channel_id, c.name AS channel, i.delivery_error AS error, count(*)::int AS n, max(i.created_at) AS last
            FROM interactions i LEFT JOIN channels c ON c.id = i.channel_id
           WHERE i.direction = 'OUTBOUND' AND i.delivery_status = 'FAILED'
             AND i.created_at >= ${at(ctx.period.start)} AND i.created_at < ${at(ctx.period.end)}
           GROUP BY 1, 2, 3
           ORDER BY n DESC`,
    );
    const webhooks = await rows<{ subscription_id: string; name: string | null; n: number; last: Date; error: string | null }>(
      ctx.db,
      sql`SELECT d.subscription_id, s.name, count(*)::int AS n, max(d.created_at) AS last, (array_agg(d.last_error ORDER BY d.created_at DESC))[1] AS error
            FROM webhook_deliveries d LEFT JOIN webhook_subscriptions s ON s.id = d.subscription_id
           WHERE d.status = 'FAILED' AND d.created_at >= ${at(ctx.period.start)} AND d.created_at < ${at(ctx.period.end)}
           GROUP BY 1, 2
           ORDER BY n DESC`,
    );
    const alerts = await rows<{ destination_id: string; n: number; last: Date; error: string | null }>(
      ctx.db,
      sql`SELECT d.destination_id, count(*)::int AS n, max(d.created_at) AS last, (array_agg(d.last_error ORDER BY d.created_at DESC))[1] AS error
            FROM alert_deliveries d
           WHERE d.status = 'FAILED' AND d.created_at >= ${at(ctx.period.start)} AND d.created_at < ${at(ctx.period.end)}
           GROUP BY 1
           ORDER BY n DESC`,
    );
    return [
      ...messages.map((m) =>
        item({
          objectKind: 'channel',
          objectId: m.channel_id,
          title: `${plural(m.n, 'message')} to customers failed on ${m.channel ?? 'a channel'}: ${m.error ? errorLine(m.error) : 'unknown error'}`,
          detail: m.error === 'session_window_closed' ? 'The channel’s messaging window had closed and no approved template was set for the message.' : 'The channel refused or could not deliver the message.',
          occurredAt: isoOf(m.last, ctx.now),
          href: '/connections?tab=channels',
          count: m.n,
        }),
      ),
      ...webhooks.map((w) =>
        item({
          objectKind: 'webhook_subscription',
          objectId: w.subscription_id,
          title: `${plural(w.n, 'webhook delivery', 'webhook deliveries')} failed for ${w.name ?? 'a subscription'}`,
          detail: w.error ? `Last error: ${errorLine(w.error)}` : 'Delivery failed after its retries.',
          occurredAt: isoOf(w.last, ctx.now),
          href: '/connections?tab=webhooks',
          count: w.n,
        }),
      ),
      ...alerts.map((a) =>
        item({
          objectKind: 'notification_destination',
          objectId: a.destination_id,
          title: `${plural(a.n, 'alert notification')} could not be delivered`,
          detail: a.error ? `Last error: ${errorLine(a.error)}` : 'Delivery failed after its retries.',
          occurredAt: isoOf(a.last, ctx.now),
          href: '/alerts',
          count: a.n,
        }),
      ),
    ];
  },
};
