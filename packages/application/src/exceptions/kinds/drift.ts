import { sql } from 'drizzle-orm';
import type { ExceptionKind } from '../contract.js';
import { liveApprovals, liveByKind } from './approvals.js';
import { ACCESS_INCREASE_ACTIONS } from './operations.js';
import { at, idsOf, isoOf, item, plural, rows, teamsOf } from './support.js';

/**
 * What the state checks cannot see (PM/research/11 §7, ADR-033): configuration
 * changed after its approval by a path that skipped maker–checker, and objects
 * whose only approval is a MIGRATION record.
 *
 * "Changed outside an approval" reads the audit trail, not snapshots: descriptor
 * projections deliberately gather related objects (an agent's prompt, tools and
 * channels), which change through their own approvals, so a projection diff
 * would flag every legitimate related change. The audit trail says exactly what
 * was written, by whom, and whether it was part of an approval (the approval's
 * decision rows share its correlation id).
 */

/**
 * Audit verbs that are stop actions (immediate by rule: pause, disable, revoke, removals, reductions) or
 * operational events that change no configuration (tests, invites, OAuth hand-shakes, provider status,
 * inert drafts). Matched on the action's last segment.
 */
const EXEMPT_VERBS =
  '(pause|disable|delete|discard|reduce|remove|member_remove|detach|channels_detach|revoke|test|invite_sent|password_reset_sent|invite_accepted|rotate_secret|classify|oauth_begin|oauth_complete|oauth_failed|auth_required|status_changed|version_create|draft_update)';

const list = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

/**
 * Decisions whose correlation id marks an audit row as part of an approval being applied. Matched on the
 * correlation alone: one approval may write rows for a related object (a prompt version's activation is
 * audited on its agent).
 */
const APPLYING = ['approval.approve', 'approval.bootstrap_approve', 'approval.activate'];

export const changedOutsideApproval: ExceptionKind = {
  id: 'changed_outside_approval',
  label: 'Changed outside an approval',
  severity: 'high',
  description:
    'Configuration writes in the period, by a person, that were not part of applying an approval: changes to an object after its approval (only stop actions are immediate), and objects taken live or re-enabled directly. From the audit trail.',
  sources: ['audit'],
  async compute(ctx) {
    const kinds = ctx.registry.all().map((d) => d.kind);
    if (!kinds.length) return [];
    const labels = new Map(ctx.registry.all().map((d) => [d.kind, d.label]));
    // Only what the kind governs: changes where its descriptor takes UPDATE proposals (a user's profile is not
    // governed, their access is), activations where it takes ACTIVATE ones.
    const updates = new Set(ctx.registry.all().filter((d) => d.actions.includes('UPDATE')).map((d) => d.kind));
    const activates = new Set(ctx.registry.all().filter((d) => d.actions.includes('ACTIVATE')).map((d) => d.kind));
    const found = await rows<{ id: string; occurred_at: Date; actor_id: string | null; actor_name: string | null; action: string; target_type: string; target_id: string | null; summary: string; team_ids: unknown; approved: boolean }>(
      ctx.db,
      sql`SELECT a.id, a.occurred_at, a.actor_id, a.actor_name, a.action, a.target_type, a.target_id, a.summary, a.team_ids,
                 EXISTS (SELECT 1 FROM approval_proposals p
                          WHERE p.object_kind = a.target_type AND p.object_id::text = a.target_id AND p.status = 'APPROVED'
                            AND p.action IN ('CREATE','UPDATE','ACTIVATE') AND p.activated_at IS NOT NULL AND p.activated_at < a.occurred_at) AS approved
            FROM audit_events a
           WHERE a.target_type IN (${list(kinds)})
             AND a.actor_type = 'USER'
             AND a.occurred_at >= ${at(ctx.period.start)} AND a.occurred_at < ${at(ctx.period.end)}
             AND a.action NOT LIKE 'auth.%'
             AND a.action NOT IN (${list(ACCESS_INCREASE_ACTIONS)})
             AND a.after->>'approvalSkipped' IS NULL
             AND a.action !~ ${`(^|[._])${EXEMPT_VERBS}$`}
             AND NOT EXISTS (SELECT 1 FROM audit_events d
                              WHERE d.correlation_id = a.correlation_id AND d.target_type = 'approval'
                                AND d.action IN (${list(APPLYING)}))
           ORDER BY a.occurred_at DESC, a.id`,
    );
    const goesLive = (r: { action: string; target_type: string }) => ['activate', 'go_live', 'enable'].some((v) => r.action === `${r.target_type}.${v}`);
    return found
      .filter((r) => (goesLive(r) ? activates.has(r.target_type) : r.approved && updates.has(r.target_type)))
      .map((r) => {
        const label = labels.get(r.target_type) ?? r.target_type;
        return item({
          objectKind: r.target_type,
          objectId: r.target_id,
          title: `${goesLive(r) ? `${label} taken live outside an approval` : `${label} changed after its approval without one`}: ${r.summary}`,
          detail: `${r.action} by ${r.actor_name ?? 'someone'}; audit event ${r.id}. Once approved, every change is a proposal and only stop actions are immediate; activation always is a proposal.`,
          occurredAt: isoOf(r.occurred_at, ctx.now),
          teamIds: teamsOf(r.team_ids),
          actorIds: idsOf(r.actor_id),
        });
      });
  },
};

export const installedOnly: ExceptionKind = {
  id: 'installed_only',
  label: 'Live on a migration record only',
  severity: 'low',
  description:
    'Live objects whose only approval is a MIGRATION record — configuration that predates maker–checker (0031) or that OCSO installed at setup — per kind, as of generation. Informational: nobody checked them.',
  async compute(ctx) {
    const out = [];
    for (const { d, ids } of await liveByKind(ctx)) {
      if (!ids.length) continue;
      const approvals = await liveApprovals(ctx.db, d.kind, ids);
      const n = [...approvals.values()].filter((a) => !a.user).length;
      if (!n) continue;
      out.push(
        item({
          objectKind: d.kind,
          objectId: null,
          title: `${plural(n, d.label.toLowerCase())} live on a migration record only`,
          detail: 'Grandfathered or installed configuration: approved by record, not by a checker. Any change to it is a proposal.',
          occurredAt: ctx.now.toISOString(),
          count: n,
        }),
      );
    }
    return out;
  },
};
