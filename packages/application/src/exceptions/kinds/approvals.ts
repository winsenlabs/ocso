import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { approvalProposals, type DbOrTx } from '@ocso/db';
import type { ApprovalDescriptor } from '../../approvals/contract.js';
import { RESTRICTED_TEAM, type ExceptionContext, type ExceptionItem, type ExceptionKind } from '../contract.js';
import { age, at, guarded, idsOf, isoOf, item, plural, proposalHref, rows, teamsOf } from './support.js';

/**
 * Maker–checker exceptions (PM/research/11 §4, §7): configuration live without
 * an approval, self-approvals under the bootstrap rule, approvals left waiting,
 * and rejected changes sent again unchanged.
 */

const CHUNK = 5_000;

/**
 * Kinds another check owns: a permission_change's "live objects" are people holding a grant no approval made
 * effective, which permission_bypass lists grant by grant (and by event). Listing them here too would count
 * one bypass twice.
 */
const OWNED_BY_OTHER_CHECKS: ReadonlySet<string> = new Set(['permission_change']);

/**
 * How each live object was approved: only an APPROVED proposal that puts the object live (CREATE, UPDATE or
 * ACTIVATE) and was actually applied (activated_at set) counts — an approved DELETE, or an approval still
 * activating, does not. `user` false: the object's only such approvals are MIGRATION records (0031, or
 * configuration OCSO installed at setup).
 */
export async function liveApprovals(db: DbOrTx, kind: string, ids: readonly string[]): Promise<Map<string, { user: boolean }>> {
  const out = new Map<string, { user: boolean }>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const found = await db
      .select({ id: approvalProposals.objectId, user: sql<boolean>`bool_or(${approvalProposals.origin} = 'USER')` })
      .from(approvalProposals)
      .where(
        and(
          eq(approvalProposals.objectKind, kind),
          eq(approvalProposals.status, 'APPROVED'),
          inArray(approvalProposals.action, ['CREATE', 'UPDATE', 'ACTIVATE']),
          isNotNull(approvalProposals.activatedAt),
          inArray(approvalProposals.objectId, slice),
        ),
      )
      .groupBy(approvalProposals.objectId);
    for (const r of found) out.set(r.id, { user: Boolean(r.user) });
  }
  return out;
}

/** A readable name from a descriptor projection (never secrets: projections are checker-visible). */
export function nameOf(projection: Record<string, unknown> | null, id: string): string {
  for (const key of ['name', 'title', 'displayName', 'label', 'agent', 'email']) {
    const v = projection?.[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return id.slice(0, 8);
}

/** Live objects of the descriptors this check walks (each descriptor call in its own savepoint). */
export async function liveByKind(ctx: { db: DbOrTx; registry: ExceptionContext['registry'] }): Promise<Array<{ d: ApprovalDescriptor; ids: string[] }>> {
  const out: Array<{ d: ApprovalDescriptor; ids: string[] }> = [];
  for (const d of ctx.registry.all()) {
    if (OWNED_BY_OTHER_CHECKS.has(d.kind)) continue;
    // A descriptor that cannot list its live objects fails the check (recorded), never silently shows nothing.
    const ids = [...new Set(await ctx.db.transaction((sp) => d.liveObjects(sp)))];
    out.push({ d, ids });
  }
  return out;
}

async function unapproved(ctx: { db: DbOrTx; now: Date }, d: ApprovalDescriptor, live: readonly string[]): Promise<ExceptionItem[]> {
  if (!live.length) return [];
  const approved = await liveApprovals(ctx.db, d.kind, live);
  const out: ExceptionItem[] = [];
  for (const id of live.filter((x) => !approved.has(x))) {
    const projection = await guarded(ctx.db, null, (sp) => d.project(sp, id));
    // Teams unknown: restricted to signers, never widened to platform-wide.
    const teamIds = await guarded(ctx.db, [RESTRICTED_TEAM], (sp) => d.teamIds(sp, id));
    out.push(
      item({
        objectKind: d.kind,
        objectId: id,
        title: `${d.label} “${nameOf(projection, id)}” is live without an approval`,
        detail: `No applied approval puts this ${d.label.toLowerCase()} live (an approved create, change or activation), yet it is live. Every live object needs one (or a MIGRATION record for configuration that predates maker–checker).`,
        occurredAt: ctx.now.toISOString(),
        teamIds,
      }),
    );
  }
  return out;
}

export const liveWithoutApproval: ExceptionKind = {
  id: 'live_without_approval',
  label: 'Live without approval',
  severity: 'critical',
  description:
    'Every registered approvable kind: its live objects without an applied approval that puts them live (create, change or activation), as of generation. Access grants are under Permissions granted without approval.',
  async compute(ctx) {
    const out: ExceptionItem[] = [];
    for (const { d, ids } of await liveByKind(ctx)) out.push(...(await unapproved(ctx, d, ids)));
    return out;
  },
};

export const bootstrapApprovals: ExceptionKind = {
  id: 'bootstrap_approvals',
  label: 'Bootstrap self-approvals',
  severity: 'high',
  description: 'Proposals the maker approved themselves because nobody else anywhere could check them (BOOTSTRAP_APPROVE), in the period.',
  async compute(ctx) {
    const found = await rows<{ proposal_id: string; occurred_at: Date; actor_id: string | null; actor_name: string; object_kind: string; object_id: string; title: string; reason: string | null; team_ids: unknown }>(
      ctx.db,
      sql`SELECT d.proposal_id, d.occurred_at, d.actor_id, d.actor_name, p.object_kind, p.object_id, p.title, d.reason, p.team_ids
            FROM approval_decisions d JOIN approval_proposals p ON p.id = d.proposal_id
           WHERE d.kind = 'BOOTSTRAP_APPROVE' AND d.occurred_at >= ${at(ctx.period.start)} AND d.occurred_at < ${at(ctx.period.end)}
           ORDER BY d.occurred_at DESC, d.proposal_id`,
    );
    return found.map((r) =>
      item({
        objectKind: 'approval',
        objectId: r.proposal_id,
        title: `${r.actor_name} approved their own change: ${r.title}`,
        detail: `Bootstrap approval (${r.object_kind}): no other eligible checker existed. ${r.reason ? `Reason given: ${r.reason}` : ''}`.trim(),
        occurredAt: isoOf(r.occurred_at, ctx.now),
        href: proposalHref(r.proposal_id, false),
        teamIds: teamsOf(r.team_ids),
        actorIds: idsOf(r.actor_id),
        // The object may be a person (a user or their access): approving yourself makes you its subject too.
        subjectIds: idsOf(r.object_id),
      }),
    );
  },
};

export const approvalsAged: ExceptionKind = {
  id: 'approvals_aged',
  label: 'Approvals waiting too long',
  severity: 'medium',
  description:
    'Open proposals older than the deployment’s approval age warning, proposals decided in the period after waiting longer than it, and approvals still activating an hour after the decision.',
  async compute(ctx) {
    const limitMs = ctx.approvalAgeWarningHours * 3_600_000;
    const cutoff = new Date(ctx.now.getTime() - limitMs);
    const open = await rows<{ id: string; title: string; submitted_at: Date; checker: string | null; team_ids: unknown }>(
      ctx.db,
      sql`SELECT p.id, p.title, p.submitted_at, u.name AS checker, p.team_ids
            FROM approval_proposals p LEFT JOIN users u ON u.id = p.checker_id
           WHERE p.status = 'SUBMITTED' AND p.submitted_at < ${at(cutoff)}
           ORDER BY p.submitted_at, p.id`,
    );
    const late = await rows<{ id: string; title: string; submitted_at: Date; decided_at: Date; status: string; team_ids: unknown }>(
      ctx.db,
      sql`SELECT p.id, p.title, p.submitted_at, p.decided_at, p.status, p.team_ids
            FROM approval_proposals p
           WHERE p.origin = 'USER' AND p.status IN ('APPROVED','REJECTED','BLOCKED')
             AND p.decided_at >= ${at(ctx.period.start)} AND p.decided_at < ${at(ctx.period.end)}
             AND p.decided_at - p.submitted_at > make_interval(hours => ${ctx.approvalAgeWarningHours})
           ORDER BY p.decided_at DESC, p.id`,
    );
    const stuck = await rows<{ id: string; title: string; decided_at: Date; activation_attempts: number; team_ids: unknown }>(
      ctx.db,
      sql`SELECT p.id, p.title, p.decided_at, p.activation_attempts, p.team_ids
            FROM approval_proposals p
           WHERE p.origin = 'USER' AND p.status = 'APPROVED' AND p.activated_at IS NULL
             AND p.decided_at < ${at(new Date(ctx.now.getTime() - 3_600_000))}
           ORDER BY p.decided_at, p.id`,
    );
    return [
      ...open.map((r) =>
        item({
          objectKind: 'approval',
          objectId: r.id,
          title: `Waiting ${age(ctx.now.getTime() - new Date(r.submitted_at).getTime())} for ${r.checker ?? 'a checker'}: ${r.title}`,
          detail: `Open longer than the ${ctx.approvalAgeWarningHours} h approval age warning.`,
          occurredAt: isoOf(r.submitted_at, ctx.now),
          href: proposalHref(r.id, true),
          teamIds: teamsOf(r.team_ids),
        }),
      ),
      ...late.map((r) =>
        item({
          objectKind: 'approval',
          objectId: r.id,
          title: `${r.status === 'REJECTED' ? 'Rejected' : 'Decided'} after ${age(new Date(r.decided_at).getTime() - new Date(r.submitted_at).getTime())}: ${r.title}`,
          detail: `Waited longer than the ${ctx.approvalAgeWarningHours} h approval age warning before the decision.`,
          occurredAt: isoOf(r.decided_at, ctx.now),
          href: proposalHref(r.id, false),
          teamIds: teamsOf(r.team_ids),
        }),
      ),
      ...stuck.map((r) =>
        item({
          objectKind: 'approval',
          objectId: r.id,
          title: `Approved but not active after ${age(ctx.now.getTime() - new Date(r.decided_at).getTime())}: ${r.title}`,
          detail: `The deferred activation has not finished (${plural(r.activation_attempts, 'attempt')}). The change is approved but not in effect.`,
          occurredAt: isoOf(r.decided_at, ctx.now),
          href: proposalHref(r.id, false),
          teamIds: teamsOf(r.team_ids),
        }),
      ),
    ];
  },
};

export const resubmittedUnchanged: ExceptionKind = {
  id: 'resubmitted_unchanged',
  label: 'Rejected changes resubmitted unchanged',
  severity: 'high',
  description: 'Proposals submitted in the period with exactly the payload and resulting configuration of an earlier rejected proposal for the same object (checker shopping).',
  async compute(ctx) {
    const found = await rows<{ id: string; title: string; submitted_at: Date; status: string; team_ids: unknown; maker_id: string | null; maker: string | null; rejected_id: string; rejected_by: string | null; decision_reason: string | null }>(
      ctx.db,
      sql`SELECT p.id, p.title, p.submitted_at, p.status, p.team_ids, p.maker_id, m.name AS maker, r.id AS rejected_id, c.name AS rejected_by, r.decision_reason
            FROM approval_proposals p
            JOIN LATERAL (
              SELECT r.id, r.decided_by, r.decision_reason FROM approval_proposals r
               WHERE r.object_kind = p.object_kind AND r.object_id = p.object_id AND r.action = p.action AND r.id <> p.id
                 AND r.status = 'REJECTED' AND r.decided_at <= p.submitted_at
                 AND r.payload = p.payload AND r.after_snapshot IS NOT DISTINCT FROM p.after_snapshot
               ORDER BY r.decided_at DESC LIMIT 1
            ) r ON true
            LEFT JOIN users m ON m.id = p.maker_id
            LEFT JOIN users c ON c.id = r.decided_by
           WHERE p.origin = 'USER' AND p.submitted_at >= ${at(ctx.period.start)} AND p.submitted_at < ${at(ctx.period.end)}
           ORDER BY p.submitted_at DESC, p.id`,
    );
    return found.map((r) =>
      item({
        objectKind: 'approval',
        objectId: r.id,
        title: `${r.maker ?? 'Someone'} resubmitted a rejected change unchanged: ${r.title}`,
        detail: `Identical to proposal ${r.rejected_id.slice(0, 8)}, rejected by ${r.rejected_by ?? 'a checker'}${r.decision_reason ? ` (“${r.decision_reason}”)` : ''}. Now ${r.status.toLowerCase()}.`,
        occurredAt: isoOf(r.submitted_at, ctx.now),
        href: proposalHref(r.id, r.status === 'SUBMITTED'),
        teamIds: teamsOf(r.team_ids),
        actorIds: idsOf(r.maker_id),
      }),
    );
  },
};
