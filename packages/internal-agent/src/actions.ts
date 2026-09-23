import { and, count, eq, gt, inArray } from 'drizzle-orm';
import { viaInternalAgent, type Principal } from '@ocso/auth';
import { SettingsService, recordAudit, type ApprovalRegistry } from '@ocso/application';
import { DomainError, forbidden, notFound, validation } from '@ocso/domain';
import { internalAgentActions, uuidv7, type Db } from '@ocso/db';
import { capabilityByName, fillPath, isAppRoute, redactResult, type Capability } from './catalog/index.js';
import { routePath, splitArgs, type SplitArgs } from './runtime/args.js';
import { buildCard, cardHash, createsGovernedObject, governCard, snapshotObject, type CardContext, type CardPlan } from './runtime/cards.js';
import { resolveNames } from './runtime/changes.js';
import { label, trimResult } from './runtime/data.js';
import { allowedFor } from './runtime/search.js';
import { apiError, type ActionCard, type CapabilityRunner, type CardStatus } from './runtime/types.js';

/** At most this many cards per user per minute (PM/research/12 §9). */
export const CARDS_PER_MINUTE = 10;

export const WRITES_OFF_MESSAGE = 'Ask OCSO writes are turned off in this deployment (a Tech admin controls this in Settings). I can still look things up; make the change in OCSO directly.';

type ActionRow = typeof internalAgentActions.$inferSelect;

/**
 * How long past its expiry a confirm may still be running. Beyond it a CONFIRMING row is one whose confirm never
 * finished (the process stopped mid-run): it reads as FAILED, never as a live card with a Confirm button.
 */
export const CONFIRM_GRACE_MS = 5 * 60_000;

const UNFINISHED: NonNullable<ActionCard['result']> = { message: 'This confirmation did not finish, so it may or may not have applied. Check the object in OCSO before asking again.' };

/** A write that ran but did not answer in time: it may or may not have applied. */
export const OUTCOME_UNKNOWN_MESSAGE = 'The change may or may not have applied; check it in OCSO';

function statusOf(row: ActionRow, now: number): CardStatus {
  if (row.status === 'CONFIRMING') return row.expiresAt.getTime() + CONFIRM_GRACE_MS < now ? 'UNKNOWN' : 'PENDING';
  return row.status === 'PENDING' && row.expiresAt.getTime() < now ? 'EXPIRED' : row.status;
}

/** Where a stored card stands now: an expired pending card is EXPIRED; a confirm still running reads as PENDING. */
export function currentCard(row: ActionRow, now = Date.now()): ActionCard | null {
  if (!row.card) return null;
  const card = row.card as unknown as ActionCard;
  const status = statusOf(row, now);
  return { ...card, status, ...(row.status === 'CONFIRMING' && status === 'UNKNOWN' ? { result: { ...UNFINISHED, ...(card.object?.href ? { href: card.object.href } : {}) } } : {}) };
}

/** A legacy proposal (before cards) as the drawer reads it in history. */
export type ActionStatus = CardStatus;

export interface ConfirmInput {
  checkerId?: string | undefined;
  reason?: string | undefined;
}

/**
 * Confirmation cards (PM/research/12 §5). The model can only ask for a card; the server builds it (object,
 * before → after, warnings, checkers), and only the same user's click runs it, through the real API route as
 * that user (a governed change becomes a proposal to the checker they chose). Cards are single use, expire
 * after 15 minutes and are refused (STALE) when the object changed since the card was built. Bootstrap
 * self-approval is never offered.
 */
export class InternalActionService {
  constructor(
    private readonly db: Db,
    private readonly runner: CapabilityRunner,
    private readonly approvals: ApprovalRegistry | null = null,
  ) {}

  /** Whether writes are on (the askOcsoWrites kill switch, a governed deployment setting). */
  async writesEnabled(): Promise<boolean> {
    return (await new SettingsService(this.db).deployment()).askOcsoWrites;
  }

  private context(principal: Principal, threadId: string, correlationId: string, ids: { cardId?: string; callId?: string }): CardContext {
    return { db: this.db, principal, runner: this.runner, approvals: this.approvals, scope: { threadId, correlationId, ...ids }, now: new Date() };
  }

  /** Build and store a card for a write. Nothing runs. */
  async propose(principal: Principal, threadId: string, callId: string, capability: Capability, args: Record<string, unknown>, split: SplitArgs, correlationId: string): Promise<ActionCard> {
    if (!(await this.writesEnabled())) throw new DomainError('policy_denied', 'ask_ocso_writes_off', WRITES_OFF_MESSAGE);
    const [recent] = await this.db
      .select({ n: count() })
      .from(internalAgentActions)
      .where(and(eq(internalAgentActions.userId, principal.userId), gt(internalAgentActions.createdAt, new Date(Date.now() - 60_000))));
    if ((recent?.n ?? 0) >= CARDS_PER_MINUTE) throw new DomainError('validation', 'card_rate_limited', `At most ${CARDS_PER_MINUTE} confirmation cards a minute: wait a moment, or make the changes in OCSO directly.`);
    const id = uuidv7();
    const { card, hash, plan } = await buildCard(this.context(principal, threadId, correlationId, { callId }), capability, args, split, id);
    await this.db.insert(internalAgentActions).values({
      id,
      threadId,
      userId: principal.userId,
      tool: capability.name,
      params: plan as unknown as Record<string, unknown>,
      risk: capability.risk,
      description: card.title,
      expiresAt: new Date(card.expiresAt),
      card: card as unknown as Record<string, unknown>,
      cardHash: hash,
      callId,
    });
    return card;
  }

  async confirm(principal: Principal, actionId: string, input: ConfirmInput, correlationId: string): Promise<ActionCard> {
    const row = await this.load(principal, actionId);
    const card = row.card as unknown as ActionCard;
    if (row.expiresAt.getTime() < Date.now()) return this.settle(row, card, 'EXPIRED', { message: 'This card expired. Ask again to see the current values.' });
    if (!(await this.writesEnabled())) throw new DomainError('policy_denied', 'ask_ocso_writes_off', WRITES_OFF_MESSAGE);
    const capability = capabilityByName(row.tool);
    if (!capability) return this.settle(row, card, 'FAILED', { message: 'This action is no longer available.' });
    // A fresh check: rights may have dropped since the card was built.
    if (!allowedFor(principal, capability)) throw forbidden(capability.permissions.list.join(capability.permissions.mode === 'all' ? '+' : '|'), 'your role no longer allows this');

    const governed = card.kind === 'governed';
    let approval: { checkerId: string; reason: string } | undefined;
    if (governed) {
      if (card.approval?.noEligibleChecker) throw validation('no_eligible_checker', 'Nobody else can approve this; open it in OCSO to continue.');
      const reason = input.reason?.trim() ?? '';
      if (!input.checkerId) throw validation('checker_required', 'Choose who approves this change.');
      if (reason.length < 3 || reason.length > 500) throw validation('reason_required', 'Give a reason of 3 to 500 characters.');
      if (card.approval && !card.approval.checkers.some((c) => c.id === input.checkerId)) throw validation('checker_not_eligible', 'Choose one of the checkers on the card.');
      approval = { checkerId: input.checkerId, reason };
    }

    const plan = row.params as unknown as CardPlan;
    const ctx = this.context(principal, row.threadId, correlationId, { cardId: row.id });
    let split: SplitArgs;
    try {
      split = splitArgs(capability, plan.args);
      const snapshot = await snapshotObject(ctx, capability, split);
      if (cardHash(capability, plan.args, split, snapshot) !== row.cardHash) {
        return this.settle(row, card, 'STALE', { message: 'This changed since the card was made. Ask again to see the current values.' }, principal, correlationId);
      }
    } catch (err) {
      if (err instanceof DomainError && (err.category === 'not_found' || err.category === 'authorization')) {
        return this.settle(row, card, 'STALE', { message: `${err.category === 'not_found' ? 'It no longer exists' : 'You can no longer see it'}. Ask again.` }, principal, correlationId);
      }
      throw err;
    }

    // Single use: only one confirm may claim the card.
    const claimed = await this.db.update(internalAgentActions).set({ status: 'CONFIRMING' }).where(and(eq(internalAgentActions.id, row.id), eq(internalAgentActions.status, 'PENDING'))).returning({ id: internalAgentActions.id });
    if (!claimed.length) throw new DomainError('conflict', 'action_not_pending', 'This card is already being confirmed or was decided');

    try {
      return await this.run(principal, row, card, capability, split, approval, ctx, correlationId);
    } catch (err) {
      // Whatever failed after the claim (the route, re-governing a card, recording the outcome), the card never stays CONFIRMING.
      return this.settle(row, card, 'FAILED', { message: `It could not be finished: ${(err as Error).message}` }, principal, correlationId, undefined, 'CONFIRMING');
    }
  }

  /** Run a claimed card's route as the user and record how it ended. */
  private async run(principal: Principal, row: ActionRow, card: ActionCard, capability: Capability, split: SplitArgs, approval: { checkerId: string; reason: string } | undefined, ctx: CardContext, correlationId: string): Promise<ActionCard> {
    const governed = card.kind === 'governed';
    const body = approval ? { ...(split.body ?? {}), approval } : split.body;
    let res;
    try {
      res = await this.runner.call(principal, ctx.scope, {
        method: capability.method as Exclude<Capability['method'], 'INSIGHT' | 'UI'>,
        path: routePath(capability, split.params),
        ...(Object.keys(split.query).length ? { query: split.query } : {}),
        ...(body !== undefined ? { body } : {}),
      });
    } catch (err) {
      return this.settle(row, card, 'FAILED', { message: `It could not be run: ${(err as Error).message}` }, principal, correlationId, undefined, 'CONFIRMING');
    }

    const error = apiError(res.body);
    const href = card.object?.href ?? resultHref(capability, split, res.body);
    if (res.status === 504 && error?.code === 'outcome_unknown') {
      // The route was sent and did not answer in time: it may still apply. Never "could not be run".
      return this.settle(row, card, 'UNKNOWN', { message: OUTCOME_UNKNOWN_MESSAGE, ...(href ? { href } : {}) }, principal, correlationId, { error }, 'CONFIRMING');
    }
    if (res.status >= 400) {
      if (error?.code === 'approval_required' && !governed) {
        const objectKind = typeof error.details?.['objectKind'] === 'string' ? error.details['objectKind'] : (card.approval?.objectKind ?? capability.approvalKind);
        const objectId = typeof error.details?.['objectId'] === 'string' ? error.details['objectId'] : card.object?.id;
        if (objectKind && objectId) {
          const next = await governCard(ctx, card, objectKind, objectId, await appliedText(ctx, error.details?.['applied']));
          await this.db.update(internalAgentActions).set({ status: 'PENDING', card: next as unknown as Record<string, unknown> }).where(and(eq(internalAgentActions.id, row.id), eq(internalAgentActions.status, 'CONFIRMING')));
          return next;
        }
      }
      if (error?.code === 'content_changed' || error?.code === 'dependency_changed') {
        return this.settle(row, card, 'STALE', { message: `${error.message} Ask again to see the current version.` }, principal, correlationId, undefined, 'CONFIRMING');
      }
      return this.settle(row, card, 'FAILED', { message: error?.message ?? `The request failed (${res.status}).` }, principal, correlationId, { error: error ?? { status: res.status } }, 'CONFIRMING');
    }

    const data = redactResult(capability, res.body);
    const answer = data as { proposal?: { id?: string; checker?: { name?: string } | null } | null; applied?: unknown; approvalRequired?: unknown; activationError?: { message?: string } | null } | null;
    const proposal = answer?.proposal;
    const applied = await appliedText(ctx, answer?.applied);
    const chosen = card.approval?.checkers.find((c) => c.id === approval?.checkerId)?.name;
    if (res.status === 202 || proposal?.id) {
      const checker = proposal?.checker?.name ?? chosen ?? 'the checker';
      const proposalId = proposal?.id;
      const message =
        capability.name === 'users.create_user'
          ? `Created ${String(split.body?.['name'] ?? 'the user')} as pending approval and sent their creation to ${checker}: they can sign in once ${checker} approves it.`
          : applied
            ? `Applied now: ${applied}. The rest was sent to ${checker} for approval and does not change until they approve it.`
            : `Sent to ${checker} for approval. Nothing changes until they approve it.`;
      return this.settle(row, card, 'SUBMITTED', { message, ...(proposalId ? { href: `/approvals?box=sent&approval=${proposalId}`, proposalId } : {}) }, principal, correlationId, trimResult(data).data, 'CONFIRMING');
    }
    const resultLink = card.object?.href ?? resultHref(capability, split, data);
    return this.settle(row, card, 'EXECUTED', { message: doneMessage(capability, card, data, { governed, checker: chosen, applied }), ...(resultLink ? { href: resultLink } : {}) }, principal, correlationId, trimResult(data).data, 'CONFIRMING');
  }

  async reject(principal: Principal, actionId: string, correlationId: string): Promise<ActionCard> {
    const row = await this.load(principal, actionId);
    const card = row.card as unknown as ActionCard;
    return this.settle(row, card, 'REJECTED', { message: 'Cancelled. Nothing changed.' }, principal, correlationId);
  }

  /** Current cards of a thread, by id. */
  async cardsOf(threadId: string): Promise<Map<string, ActionCard | { status: CardStatus }>> {
    const rows = await this.db.select().from(internalAgentActions).where(eq(internalAgentActions.threadId, threadId));
    const now = Date.now();
    return new Map(rows.map((r) => [r.id, currentCard(r, now) ?? { status: statusOf(r, now) }]));
  }

  /** Cards by id (for history lines given back to the model). */
  async cards(ids: readonly string[]): Promise<ActionCard[]> {
    if (!ids.length) return [];
    const rows = await this.db.select().from(internalAgentActions).where(inArray(internalAgentActions.id, [...ids]));
    return rows.flatMap((r) => {
      const c = currentCard(r);
      return c ? [c] : [];
    });
  }

  /**
   * Record the outcome: the card's final status and result, and an audit row (the human, via INTERNAL_AGENT, with
   * thread and card). Only from the status this path expects (`from`): PENDING before the single-use claim,
   * CONFIRMING after it. A second, racing confirm or cancel that lost the claim never overwrites how the card ended.
   */
  private async settle(row: ActionRow, card: ActionCard, status: CardStatus, result: NonNullable<ActionCard['result']>, principal?: Principal, correlationId?: string, data?: unknown, from: 'PENDING' | 'CONFIRMING' = 'PENDING'): Promise<ActionCard> {
    const next: ActionCard = { ...card, status, result };
    await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(internalAgentActions)
        .set({
          status,
          card: next as unknown as Record<string, unknown>,
          result: (data === undefined ? { message: result.message } : { message: result.message, data }) as Record<string, unknown>,
          decidedAt: new Date(),
          ...(result.proposalId ? { proposalId: result.proposalId } : {}),
        })
        .where(and(eq(internalAgentActions.id, row.id), eq(internalAgentActions.status, from)))
        .returning({ id: internalAgentActions.id });
      if (!updated.length) throw new DomainError('conflict', 'action_not_pending', 'This card is already being confirmed or was decided');
      if (principal && correlationId && status !== 'EXPIRED') {
        const actor = { principal: { ...viaInternalAgent(principal), delegation: { threadId: row.threadId, cardId: row.id } }, correlationId };
        const action =
          status === 'REJECTED' ? 'internal_agent.action_rejected' : status === 'EXECUTED' || status === 'SUBMITTED' ? 'internal_agent.action_confirmed' : status === 'UNKNOWN' ? 'internal_agent.action_unknown' : 'internal_agent.action_failed';
        const auditId = await recordAudit(tx, actor, {
          action,
          targetType: 'internal_agent_action',
          targetId: row.id,
          summary: `${status === 'REJECTED' ? 'Cancelled' : status === 'EXECUTED' ? 'Confirmed' : status === 'SUBMITTED' ? 'Submitted for approval' : status === 'STALE' ? 'Refused (changed)' : status === 'UNKNOWN' ? 'Outcome unknown' : 'Failed'}: ${card.title}`,
          confirmation: { confirmedBy: principal.userId, tool: row.tool, kind: card.kind, status, ...(result.proposalId ? { proposalId: result.proposalId } : {}) },
          ...(status === 'EXECUTED' || status === 'SUBMITTED' || status === 'UNKNOWN' ? { after: (row.params as { args?: unknown }).args ?? {} } : {}),
        });
        await tx.update(internalAgentActions).set({ auditEventId: auditId }).where(eq(internalAgentActions.id, row.id));
      }
    });
    return next;
  }

  private async load(principal: Principal, actionId: string): Promise<ActionRow> {
    const [row] = await this.db.select().from(internalAgentActions).where(and(eq(internalAgentActions.id, actionId), eq(internalAgentActions.userId, principal.userId)));
    if (!row) throw notFound('internal_agent_action', actionId);
    if (!row.card) throw new DomainError('conflict', 'action_outdated', 'This proposal is from an earlier version of Ask OCSO. Ask again to get a confirmation card.');
    if (row.status !== 'PENDING') throw new DomainError('conflict', 'action_not_pending', `Action is already ${row.status === 'CONFIRMING' ? 'being confirmed' : row.status.toLowerCase()}`);
    return row;
  }
}

/**
 * What the user is told when a card ran, as it happened: a bulk approval says how many were approved and which were
 * skipped; a create that left an inert draft says so (never "Done"); a governed card the route applied directly
 * says no approval was asked for; an edit whose stop part applied says which part.
 */
function doneMessage(capability: Capability, card: ActionCard, data: unknown, how: { governed: boolean; checker?: string | undefined; applied?: string | undefined }): string {
  if (capability.name === 'approvals.bulk_approve') {
    const r = data as { approved?: unknown[]; skipped?: Array<{ message?: string }> } | null;
    const skipped = r?.skipped ?? [];
    return `Approved ${r?.approved?.length ?? 0}${skipped.length ? `; skipped ${skipped.length}: ${skipped.map((x) => x.message ?? 'refused').join(' ')}` : ''}.`;
  }
  const d = data as { approvalRequired?: unknown; activationError?: { message?: unknown } | null } | null;
  if (d?.approvalRequired) {
    return `Saved as a draft: ${card.title}. It does nothing until it is approved, and nobody has been asked to approve it yet: submit it for approval in OCSO, or discard it.`;
  }
  if (d?.activationError) {
    return `Saved as a draft: ${card.title}, but it could not be sent for approval (${String(d.activationError.message ?? 'refused')}). It does nothing until it is approved.`;
  }
  if (how.governed) return `Applied directly: ${card.title}. OCSO did not need an approval for it, so nothing was sent to ${how.checker ?? 'a checker'}.`;
  if (createsGovernedObject(capability)) return `Created as a draft: ${card.title}. It is not in use until it is approved; submit it for approval in OCSO.`;
  if (how.applied) return `Done: ${card.title} (${how.applied}).`;
  return `Done: ${card.title}.`;
}

/** What a route says it applied at once (`applied`: removed teams, revoked tool grants…), in words, named where the user may read the names. */
async function appliedText(ctx: CardContext, applied: unknown): Promise<string | undefined> {
  if (!applied || typeof applied !== 'object') return undefined;
  const parts = Object.entries(applied as Record<string, unknown>).filter(([, v]) => Array.isArray(v) && v.length) as Array<[string, string[]]>;
  if (!parts.length) return undefined;
  const names = await resolveNames(ctx.db, ctx.principal, parts.flatMap(([, v]) => v));
  const words: Record<string, string> = { removedTeamIds: 'removed teams', removedTransferTargetIds: 'removed transfer targets', removed: 'revoked tool grants', narrowed: 'narrowed tool grants', granted: 'granted tools' };
  return parts.map(([k, v]) => `${words[k] ?? label(k)}: ${v.map((id) => names.get(id) ?? id).join(', ')}`).join('; ');
}

/** The page of what a direct write created or changed, from the route's result and the capability's page. */
function resultHref(capability: Capability, split: SplitArgs, data: unknown): string | undefined {
  if (!capability.uiHref) return undefined;
  const id = (data as { id?: unknown } | null)?.id;
  const href = fillPath(capability.uiHref, { ...split.params, ...(typeof id === 'string' ? { id } : {}) });
  return href && isAppRoute(href) ? href : undefined;
}
