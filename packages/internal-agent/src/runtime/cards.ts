import { Permission, can, type Principal } from '@ocso/auth';
import { canMake, eligibleCheckers, type ApprovalRegistry } from '@ocso/application';
import { DomainError } from '@ocso/domain';
import type { Db } from '@ocso/db';
import { isStopCall, type Capability } from '../catalog/index.js';
import { label, sha256, stableJson } from './data.js';
import { bulkApprovalChanges, changesFor, widensRights } from './changes.js';
import { routePath, type SplitArgs } from './args.js';
import { get, objectReadCapability, paramNames, snapshotObject, type ObjectSnapshot } from './snapshot.js';
import { partialStop } from './partial-stop.js';
import type { ActionCard, CapabilityRunner, CardChange, CardChecker, DelegationScope } from './types.js';

export { createsGovernedObject, objectReadCapability, snapshotObject, type ObjectSnapshot } from './snapshot.js';
export { partialStop, type PartialStop } from './partial-stop.js';

/** Cards expire after 15 minutes (PM/research/12 §5). */
export const CARD_TTL_MS = 15 * 60_000;

export interface CardContext {
  db: Db;
  principal: Principal;
  runner: CapabilityRunner;
  approvals: ApprovalRegistry | null;
  scope: DelegationScope;
  now: Date;
}

/** Everything confirm needs besides the card (stored in the action row's params). */
export interface CardPlan {
  args: Record<string, unknown>;
  objectKind: string | null;
  objectId: string | null;
}

/** An id no row has: the eligibility facts of a user who does not exist yet. */
const NO_OBJECT = '00000000-0000-0000-0000-000000000000';

/** "agents.update_agent" → "Update agent"; "approvals.decide_approval" → "Decide approval". */
export function titleOf(capability: Capability): string {
  const words = (capability.name.split('.')[1] ?? capability.name).replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What the card hash covers: the arguments and the object state the user saw (the fields it changes, its status and version). */
export function cardHash(capability: Capability, args: Record<string, unknown>, split: SplitArgs, snapshot: ObjectSnapshot): string {
  const keys = new Set([...Object.keys(split.body ?? {}), 'status', 'updatedAt', 'revision', 'contentHash', 'version', 'enabled', 'args', 'argsHash', 'toolName']);
  const current = snapshot.current ? Object.fromEntries(Object.entries(snapshot.current).filter(([k]) => keys.has(k))) : null;
  return sha256(stableJson({ tool: capability.name, args, current, projection: snapshot.projection }));
}

/** The second line high-risk capabilities always show (PM/research/12 §9): credentials, rights, deletions, settings. */
const HIGH_RISK: Array<[RegExp, (name: string) => string]> = [
  [/^users\.(change_user_permissions|update_user|add_team_member|remove_team_member|create_user)$/, (n) => `You are about to change who can do what in OCSO${n ? ` (${n})` : ''}.`],
  [/^settings\./, () => 'You are about to change deployment-wide settings.'],
  [/^models\.(create_provider|update_provider)$/, (n) => `You are about to change a model provider${n ? ` (${n})` : ''}.`],
  [/^(mcp|webhooks)\./, (n) => `You are about to change an external connection${n ? ` (${n})` : ''}.`],
  [/^security\./, () => 'You are about to change a security credential: anything signed with the old key stops being accepted.'],
  [/^channels\.update_channel$/, (n) => `You are about to change a customer channel's connection${n ? ` (${n})` : ''}.`],
  [/^approvals\.bulk_approve$/, () => 'You are about to approve every proposal listed here: each applies as if you approved it on its own.'],
  [/^approvals\.decide_approval$/, (n) => `You are about to decide someone else's change${n ? ` (${n})` : ''}: an approval applies it.`],
  [/^conversations\.(confirm_tool_call|run_conversation_tool)$/, (n) => `You are about to run a tool on a customer's behalf${n ? ` (${n})` : ''}: it acts in an external system as you, with exactly the arguments shown.`],
];

/** A card larger than this (all its values together) is refused: nobody reviews that much in one click. */
const CARD_TEXT_MAX = 60_000;

interface ApprovalStateBody {
  approved?: boolean;
  pending?: { id: string; checkerName?: string | null } | null;
  updateNeedsApproval?: boolean;
}

/** Eligible checkers for the object (the approvals route, as this user); the first is suggested. Bootstrap is never offered. */
export async function checkersFor(ctx: CardContext, objectKind: string, objectId: string): Promise<CardChecker[] | null> {
  const res = await get(ctx, '/v1/approvals/checkers', { objectKind, objectId });
  if (res.status >= 400) return null;
  const list = ((res.body as { checkers?: Array<{ id: string; name: string; role: string | null }> } | null)?.checkers ?? []).filter((c) => c.id !== ctx.principal.userId);
  return list.map((c, i) => ({ id: c.id, name: c.name, role: c.role ?? '', suggested: i === 0 }));
}

/**
 * Who may check a new user's creation (PM/research/11 §3.4), before the user exists: the `user` descriptor's own
 * eligibility for the teams the user will join, under the rule the checkers route applies (approvals.read and the
 * right to propose it). The route checks the chosen checker again when the proposal is submitted.
 */
async function newUserCheckers(ctx: CardContext, body: Record<string, unknown> | undefined): Promise<CardChecker[]> {
  const d = ctx.approvals?.has('user') ? ctx.approvals.get('user') : null;
  if (!d || !can(ctx.principal, Permission.APPROVALS_READ) || !canMake(ctx.principal, d, 'CREATE')) return [];
  const teamIds = [...new Set(Array.isArray(body?.['teamIds']) ? (body['teamIds'] as string[]) : [])].sort();
  const found = await eligibleCheckers(ctx.db, d, { makerId: ctx.principal.userId, teamIds, objectKind: 'user', objectId: NO_OBJECT, action: 'CREATE', payload: { teams: { add: teamIds } } }, [ctx.principal.userId]);
  const directory = can(ctx.principal, Permission.USERS_READ);
  return found.map((c, i) => ({ id: c.id, name: c.name, role: directory ? (c.role ?? '') : '', suggested: i === 0 }));
}

/**
 * Turning an object on through a route that also stops it (`status: 'ACTIVE'` / `'LIVE'`, `enabled: true` where
 * `stopWhen` is the off value): an ACTIVATE, always a proposal. Users are left out: their status mixes reductions
 * (applied at once) with a proposed widening, which the route's own answer settles.
 */
function activates(capability: Capability, body: Record<string, unknown> | undefined): boolean {
  if (!capability.stopWhen || !body || capability.approvalKind === 'permission_change') return false;
  return Object.entries(capability.stopWhen).some(([key, off]) => key in body && body[key] !== off && (body[key] === true || body[key] === 'ACTIVE' || body[key] === 'LIVE'));
}

export interface BuiltCard {
  card: ActionCard;
  hash: string;
  plan: CardPlan;
}

/**
 * Build the confirmation card for a write (PM/research/12 §5). Nothing runs: the object is read through its
 * own GET route as the user (so a card is never built for an object they cannot see), maker–checker state and
 * the eligible checkers come from the approvals routes, and the before → after comes from the approval
 * descriptor's projection for governed changes, else from the object's fields.
 */
export async function buildCard(ctx: CardContext, capability: Capability, args: Record<string, unknown>, split: SplitArgs, cardId: string): Promise<BuiltCard> {
  routePath(capability, split.params);
  const snapshot = await snapshotObject(ctx, capability, split);
  // A write to an object named in its path (`/v1/…/:id`) must show which object: a card that cannot is refused.
  if (paramNames(capability.path).length && !snapshot.current && !snapshot.projection && !snapshot.context.length) {
    throw new DomainError('validation', 'object_not_identified', `Ask OCSO cannot show which object ${capability.name} would change, so it makes no card for it. Make this change in OCSO directly.`);
  }
  if (snapshot.kind === 'tool_call' && snapshot.current?.['status'] !== 'AWAITING_CONFIRMATION') {
    throw new DomainError('conflict', 'tool_call_not_waiting', `This tool call is not waiting for confirmation (it is ${String(snapshot.current?.['status'] ?? 'gone').toLowerCase().replaceAll('_', ' ')}).`);
  }
  const partial = await partialStop(ctx, capability, split.body, snapshot.current);
  const stop = isStopCall(capability, split.body) || partial?.kind === 'stop';
  const warnings: string[] = [];

  // A decision carries the content hash the checker saw: a proposal edited since is refused now, as it would be on confirm.
  if (capability.name === 'approvals.decide_approval' && snapshot.current && typeof split.body?.['contentHash'] === 'string' && snapshot.current['contentHash'] !== split.body['contentHash']) {
    throw new DomainError('conflict', 'content_changed', 'The proposal changed since it was read: read it again (approvals.get_approval) and use its current contentHash.');
  }

  let governed = false;
  let approval: ActionCard['approval'];
  if (capability.approvalKind && !stop) {
    if (capability.name === 'users.create_user') {
      // A new user is inert (PENDING_APPROVAL) until a checker approves their creation: the card always submits it.
      governed = true;
      const checkers = await newUserCheckers(ctx, split.body);
      approval = { objectKind: 'user', checkers, noEligibleChecker: checkers.length === 0 };
      if (!checkers.length) warnings.push('Nobody else can approve this; open it in OCSO to continue.');
    } else if (snapshot.approvalId) {
      const res = await get(ctx, '/v1/approvals/state', { objectKind: capability.approvalKind, objectId: snapshot.approvalId });
      const state = res.status < 400 ? (res.body as ApprovalStateBody) : null;
      const alwaysProposal =
        capability.method === 'DELETE' || /\/(activate|approve|enable|submit)$/.test(capability.path) || capability.approvalKind === 'deployment_settings' || activates(capability, split.body) || widensRights(capability, split.body, snapshot.current);
      governed = alwaysProposal || state?.updateNeedsApproval === true;
      if (state?.pending) warnings.push('A change to this object is already waiting for approval: this one is refused until that proposal is decided or withdrawn.');
      if (governed) {
        const checkers = (await checkersFor(ctx, capability.approvalKind, snapshot.approvalId)) ?? [];
        approval = { objectKind: capability.approvalKind, checkers, noEligibleChecker: checkers.length === 0, ...(snapshot.href ? { uiHref: snapshot.href } : {}) };
        if (!checkers.length) warnings.push('Nobody else can approve this; open it in OCSO to continue.');
      }
    }
  }
  if (governed && partial?.kind === 'mixed') warnings.push(`Part of this applies at once when you confirm (${partial.now}); the rest goes to the checker you choose.`);

  let changes: CardChange[];
  if (capability.name === 'approvals.bulk_approve') {
    const bulk = await bulkApprovalChanges(ctx, split);
    changes = bulk.changes;
    warnings.push(...bulk.warnings);
  } else {
    changes = [...snapshot.context, ...(await changesFor(ctx, capability, split, snapshot, governed, objectReadCapability(capability)?.path ?? capability.path))];
  }
  if (changes.reduce((n, c) => n + c.label.length + (c.before?.length ?? 0) + c.after.length, 0) > CARD_TEXT_MAX) {
    throw new DomainError('validation', 'card_too_large', 'This change is too large to review on one confirmation card. Split it into smaller changes, or make it in OCSO directly.');
  }
  if (changes.length === snapshot.context.length && split.body && Object.keys(split.body).length && capability.method !== 'POST') warnings.push('Nothing would change: these values are already set.');
  const where = snapshot.context.map((c) => c.after);
  const what = snapshot.name ?? `this ${snapshot.kind ? label(snapshot.kind) : 'object'}`;
  if (capability.method === 'DELETE') {
    warnings.unshift(stop ? `You are about to remove ${what}${where.length ? ` from ${where.join(', ')}` : ''}. It applies at once.` : `You are about to delete ${what}. This cannot be undone.`);
  }
  for (const [pattern, line] of HIGH_RISK) if (pattern.test(capability.name)) warnings.unshift(line(snapshot.name ?? ''));

  const card: ActionCard = {
    id: cardId,
    tool: capability.name,
    title: [titleOf(capability), snapshot.name, ...where].filter(Boolean).join(' · '),
    summary: capability.summary,
    kind: stop ? 'stop' : governed ? 'governed' : 'direct',
    ...(snapshot.id && snapshot.kind ? { object: { kind: snapshot.kind, id: snapshot.id, name: snapshot.name ?? label(snapshot.kind), ...(snapshot.href ? { href: snapshot.href } : {}) } } : {}),
    changes,
    warnings,
    ...(approval ? { approval } : {}),
    expiresAt: new Date(ctx.now.getTime() + CARD_TTL_MS).toISOString(),
    status: 'PENDING',
  };
  return { card, hash: cardHash(capability, args, split, snapshot), plan: { args, objectKind: capability.approvalKind ?? snapshot.kind, objectId: snapshot.approvalId ?? snapshot.id } };
}

/** A governed card for a write the route answered 409 approval_required (the prediction said direct). */
export async function governCard(ctx: CardContext, card: ActionCard, objectKind: string, objectId: string, applied?: string): Promise<ActionCard> {
  const checkers = (await checkersFor(ctx, objectKind, objectId)) ?? [];
  const warnings = card.warnings.filter((w) => !w.startsWith('Nobody else can approve'));
  if (!checkers.length) warnings.push('Nobody else can approve this; open it in OCSO to continue.');
  return {
    ...card,
    kind: 'governed',
    approval: { objectKind, checkers, noEligibleChecker: checkers.length === 0, ...(card.object?.href ? { uiHref: card.object.href } : {}) },
    warnings: ['This change needs approval: choose who approves it and give a reason.', ...(applied ? [`Already applied: ${applied}.`] : []), ...warnings],
    status: 'PENDING',
  };
}
