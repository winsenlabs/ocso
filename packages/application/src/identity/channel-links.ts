import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { and, count, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { Permission, can, type Principal } from '@ocso/auth';
import { channelAccountLinks, channelLinkTokens, channels, users, uuidv7, type DbOrTx } from '@ocso/db';
import { DomainError, conflict, forbidden, notFound, validation } from '@ocso/domain';
import { recordAudit } from '../audit/audit.js';
import { maskIdentity } from '../conversations/masking.js';
import type { ActorContext } from '../shared/context.js';
import { loadPrincipal } from './sessions.js';

/**
 * Chat account links (Ask OCSO over Slack, Teams and any channel whose descriptor sets `staffDestination`): a chat
 * identity on one channel (the adapter's identity kind and value) linked to one OCSO user, who then asks Ask OCSO
 * from chat as themselves.
 *
 * An unknown sender gets a one-time link (`/link/<token>`): 32 random bytes, only the sha256 stored, bound to the
 * channel and chat identity, 10 minutes, used once. Opening it signed in to OCSO and confirming claims it for that
 * user and shows them a short code; the link is made (audited, actor = the user) only when the same chat identity
 * sends that code back. The token alone proves nothing about who confirms it: without the code step, anyone in a
 * workspace could send their link to an admin ("please confirm my access") and then ask Ask OCSO as that admin.
 * A chat identity is linked to at most one active user per channel. Revoking is immediate (the user themselves, or
 * a Tech admin with users.manage); disabling a user and break-glass recovery revoke their links.
 */

export const LINK_TOKEN_TTL_MS = 10 * 60_000;
/** At most this many link tokens per chat identity per token lifetime: an unlinked sender cannot flood the table. */
export const LINK_TOKENS_PER_WINDOW = 3;
/** Digits of the code the link page shows and the chat identity sends back. */
export const LINK_CODE_DIGITS = 6;
/** Wrong codes a claimed link token tolerates before it is burned (the user confirms on a fresh link again). */
export const LINK_CODE_ATTEMPTS = 5;

type LinkRow = typeof channelAccountLinks.$inferSelect;
export type ChatLink = LinkRow;

/** A link as the account page and the user page list it. */
export interface ChatLinkView {
  id: string;
  channel: { id: string; name: string; kind: string };
  /** The chat identity as staff see it (the channel plugin's display, e.g. `slack · U0123`). */
  identity: string;
  profileName: string | null;
  userId: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export const hashLinkToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** A link token's shape (base64url of 32 bytes); anything else is refused before a lookup. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Why this user may not ask Ask OCSO from chat (null = they may). Rights are read fresh from the principal. */
export function chatLinkRefusal(principal: Principal | null): string | null {
  if (!principal) return 'Your OCSO account is not active.';
  if (!can(principal, Permission.INTERNAL_AGENT_USE)) return 'Your OCSO role does not include Ask OCSO (internal_agent.use).';
  return null;
}

/**
 * A new one-time link for a chat identity, or null when this identity already has LINK_TOKENS_PER_WINDOW live
 * tokens (the earlier messages already carry a link). Returns the raw token: it is sent to the chat, never stored.
 */
export async function issueLinkToken(
  db: DbOrTx,
  input: { channelId: string; identityKind: string; identityValue: string; profileName?: string | undefined; replyContext?: Readonly<Record<string, string>> | undefined },
  now = new Date(),
): Promise<string | null> {
  const [recent] = await db
    .select({ n: count() })
    .from(channelLinkTokens)
    .where(
      and(
        eq(channelLinkTokens.channelId, input.channelId),
        eq(channelLinkTokens.identityKind, input.identityKind),
        eq(channelLinkTokens.identityValue, input.identityValue),
        gt(channelLinkTokens.createdAt, new Date(now.getTime() - LINK_TOKEN_TTL_MS)),
      ),
    );
  if ((recent?.n ?? 0) >= LINK_TOKENS_PER_WINDOW) return null;
  // Expired tokens are useless: drop them as new ones are made.
  await db.delete(channelLinkTokens).where(sql`${channelLinkTokens.expiresAt} < ${new Date(now.getTime() - 24 * 3_600_000)}`);
  const token = randomBytes(32).toString('base64url');
  await db.insert(channelLinkTokens).values({
    tokenHash: hashLinkToken(token),
    channelId: input.channelId,
    identityKind: input.identityKind,
    identityValue: input.identityValue,
    profileName: input.profileName?.slice(0, 200) ?? null,
    replyContext: input.replyContext ? { ...input.replyContext } : null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + LINK_TOKEN_TTL_MS),
  });
  return token;
}

/** The active link of a chat identity on a channel. */
export async function findActiveChatLink(db: DbOrTx, channelId: string, identityKind: string, identityValue: string): Promise<LinkRow | null> {
  const [row] = await db
    .select()
    .from(channelAccountLinks)
    .where(and(eq(channelAccountLinks.channelId, channelId), eq(channelAccountLinks.identityKind, identityKind), eq(channelAccountLinks.identityValue, identityValue), isNull(channelAccountLinks.revokedAt)))
    .limit(1);
  return row ?? null;
}

/** A link by id while it is active (not revoked). */
export async function activeChatLink(db: DbOrTx, linkId: string): Promise<LinkRow | null> {
  const [row] = await db
    .select()
    .from(channelAccountLinks)
    .where(and(eq(channelAccountLinks.id, linkId), isNull(channelAccountLinks.revokedAt)))
    .limit(1);
  return row ?? null;
}

export type LinkTokenState = 'valid' | 'expired' | 'used' | 'invalid';

/** What the `/link/<token>` page shows before the user confirms. */
export interface LinkTokenPreview {
  state: LinkTokenState;
  channel?: { id: string; name: string; kind: string } | undefined;
  identity?: string | undefined;
  /** The chat account's full id as the channel sent it (e.g. `T…:U…`: Slack workspace and user; Teams tenant and user). */
  account?: string | undefined;
  profileName?: string | null | undefined;
  /** Why this user cannot confirm it (not active, no Ask OCSO, already linked to someone else); null = they can. */
  refusal: string | null;
  /** The identity is already linked to this very user. */
  alreadyLinked: boolean;
}

type TokenRow = typeof channelLinkTokens.$inferSelect;

async function tokenRow(db: DbOrTx, token: string, forUpdate = false): Promise<TokenRow | null> {
  if (!TOKEN.test(token)) return null;
  const query = db.select().from(channelLinkTokens).where(eq(channelLinkTokens.tokenHash, hashLinkToken(token))).limit(1);
  const [row] = forUpdate ? await query.for('update') : await query;
  return row ?? null;
}

function tokenState(row: TokenRow | null, now: Date): LinkTokenState {
  if (!row) return 'invalid';
  if (row.usedAt) return 'used';
  return row.expiresAt.getTime() <= now.getTime() ? 'expired' : 'valid';
}

async function channelOf(db: DbOrTx, channelId: string): Promise<{ id: string; name: string; kind: string; status: string } | null> {
  const [row] = await db.select({ id: channels.id, name: channels.name, kind: channels.kind, status: channels.status }).from(channels).where(eq(channels.id, channelId));
  return row ?? null;
}

async function identityRefusal(db: DbOrTx, row: TokenRow, userId: string): Promise<{ refusal: string | null; alreadyLinked: boolean }> {
  const existing = await findActiveChatLink(db, row.channelId, row.identityKind, row.identityValue);
  if (!existing) return { refusal: null, alreadyLinked: false };
  if (existing.userId === userId) return { refusal: null, alreadyLinked: true };
  return { refusal: 'This chat account is already linked to another OCSO user. They (or a Tech admin) must revoke that link first.', alreadyLinked: false };
}

export async function previewLinkToken(db: DbOrTx, principal: Principal, token: string, now = new Date()): Promise<LinkTokenPreview> {
  const row = await tokenRow(db, token);
  const state = tokenState(row, now);
  if (!row || state !== 'valid') return { state, refusal: null, alreadyLinked: false };
  const channel = await channelOf(db, row.channelId);
  if (!channel) return { state: 'invalid', refusal: null, alreadyLinked: false };
  const own = chatLinkRefusal(principal);
  const { refusal, alreadyLinked } = own ? { refusal: own, alreadyLinked: false } : await identityRefusal(db, row, principal.userId);
  return {
    state,
    channel: { id: channel.id, name: channel.name, kind: channel.kind },
    identity: maskIdentity(`${row.identityKind}:${row.identityValue}`) ?? row.identityKind,
    account: row.identityValue,
    profileName: row.profileName,
    refusal,
    alreadyLinked,
  };
}

interface LinkNotify {
  channelId: string;
  identityKind: string;
  identityValue: string;
  replyContext: Record<string, string> | null;
}

/** The link page's Confirm: either the identity was already this user's (refreshed at once), or a code to send from chat. */
export type ConfirmedChatLink =
  | { kind: 'linked'; link: LinkRow; notify: LinkNotify }
  | { kind: 'code'; code: string; expiresAt: Date; notify: LinkNotify };

const codeHash = (tokenHash: string, code: string) => createHash('sha256').update(`${tokenHash}:${code}`, 'utf8').digest('hex');

/**
 * The link page's Confirm. Refused when the token expired or was used, for a user who is not ACTIVE or lacks
 * internal_agent.use, and when the identity is linked to another active user. When the identity is already linked
 * to this user (they link again, e.g. after the MFA policy tightened), the link's sign-in method is refreshed at
 * once. Otherwise the token is claimed for this user and a fresh code is returned: the link is made only when the
 * same chat identity sends that code (`completeChatLink`). Confirming again replaces the code.
 */
export async function confirmLinkToken(db: DbOrTx, actor: ActorContext, authMethod: string, token: string, now = new Date()): Promise<ConfirmedChatLink> {
  const principal = actor.principal;
  if (!principal) throw forbidden(Permission.INTERNAL_AGENT_USE);
  const run = async (tx: DbOrTx): Promise<ConfirmedChatLink> => {
    const row = await tokenRow(tx, token, true);
    const state = tokenState(row, now);
    if (!row || state === 'invalid') throw notFound('link_token', 'this link');
    if (state === 'used') throw conflict('link_token_used', 'This link was already used. Send the app a new message to get a fresh one.');
    if (state === 'expired') throw validation('link_token_expired', 'This link expired (links last 10 minutes). Send the app a new message to get a fresh one.');
    const refusal = chatLinkRefusal(principal);
    if (refusal) throw new DomainError('authorization', 'chat_link_not_allowed', refusal);
    const [user] = await tx.select({ status: users.status }).from(users).where(eq(users.id, principal.userId));
    if (user?.status !== 'ACTIVE') throw new DomainError('authorization', 'chat_link_not_allowed', 'Your OCSO account is not active.');
    const channel = await channelOf(tx, row.channelId);
    if (!channel) throw notFound('channel', row.channelId);
    const identity = await identityRefusal(tx, row, principal.userId);
    if (identity.refusal) throw conflict('chat_identity_linked', identity.refusal);
    const notify = { channelId: row.channelId, identityKind: row.identityKind, identityValue: row.identityValue, replyContext: row.replyContext ?? null };
    if (identity.alreadyLinked) {
      await tx.update(channelLinkTokens).set({ usedAt: now }).where(eq(channelLinkTokens.tokenHash, row.tokenHash));
      // Linking again refreshes how the user signed in (the MFA policy may have changed since).
      const [existing] = await tx
        .update(channelAccountLinks)
        .set({ authMethod })
        .where(and(eq(channelAccountLinks.channelId, row.channelId), eq(channelAccountLinks.identityKind, row.identityKind), eq(channelAccountLinks.identityValue, row.identityValue), isNull(channelAccountLinks.revokedAt)))
        .returning();
      return { kind: 'linked', link: existing!, notify };
    }
    const code = String(randomInt(0, 10 ** LINK_CODE_DIGITS)).padStart(LINK_CODE_DIGITS, '0');
    const expiresAt = new Date(now.getTime() + LINK_TOKEN_TTL_MS);
    await tx
      .update(channelLinkTokens)
      .set({ claimedBy: principal.userId, claimCodeHash: codeHash(row.tokenHash, code), claimAuthMethod: authMethod, claimAttempts: 0, expiresAt })
      .where(eq(channelLinkTokens.tokenHash, row.tokenHash));
    return { kind: 'code', code, expiresAt, notify };
  };
  return 'transaction' in db ? db.transaction(run) : run(db);
}

/** What a message from an unlinked chat identity did to its claimed link tokens. */
export type ChatLinkCompletion =
  | { kind: 'none' }
  | { kind: 'waiting' }
  | { kind: 'wrong'; attemptsLeft: number }
  | { kind: 'refused'; reason: string }
  | { kind: 'linked'; link: LinkRow };

/** A code as people type it: digits with optional spaces or dashes, nothing else. */
function codeIn(text: string): string | null {
  const compact = text.trim().replace(/[\s-]/g, '');
  return new RegExp(`^\\d{${LINK_CODE_DIGITS}}$`).test(compact) ? compact : null;
}

/**
 * A message from a chat identity with no active link: when a link page claimed one of its tokens, the message must
 * be that page's code. The right code links the identity to the claiming user (audited as `channel.account_link`,
 * actor = that user); a wrong one counts against the claim (burned after LINK_CODE_ATTEMPTS); any other text is told
 * to send the code. `none` = nothing is waiting for a code (the caller offers a link).
 */
export async function completeChatLink(
  db: DbOrTx,
  input: { channelId: string; identityKind: string; identityValue: string; text: string; correlationId: string },
  now = new Date(),
): Promise<ChatLinkCompletion> {
  const run = async (tx: DbOrTx): Promise<ChatLinkCompletion> => {
    const claimed = await tx
      .select()
      .from(channelLinkTokens)
      .where(
        and(
          eq(channelLinkTokens.channelId, input.channelId),
          eq(channelLinkTokens.identityKind, input.identityKind),
          eq(channelLinkTokens.identityValue, input.identityValue),
          isNull(channelLinkTokens.usedAt),
          gt(channelLinkTokens.expiresAt, now),
          sql`${channelLinkTokens.claimedBy} IS NOT NULL`,
        ),
      )
      .for('update');
    if (!claimed.length) return { kind: 'none' };
    const code = codeIn(input.text);
    if (!code) return { kind: 'waiting' };
    const match = claimed.find((row) => {
      const want = Buffer.from(row.claimCodeHash ?? '', 'utf8');
      const got = Buffer.from(codeHash(row.tokenHash, code), 'utf8');
      return want.length === got.length && timingSafeEqual(want, got);
    });
    if (!match) {
      let left = 0;
      for (const row of claimed) {
        const attempts = row.claimAttempts + 1;
        await tx
          .update(channelLinkTokens)
          .set({ claimAttempts: attempts, ...(attempts >= LINK_CODE_ATTEMPTS ? { usedAt: now } : {}) })
          .where(eq(channelLinkTokens.tokenHash, row.tokenHash));
        left = Math.max(left, LINK_CODE_ATTEMPTS - attempts);
      }
      return { kind: 'wrong', attemptsLeft: left };
    }
    await tx.update(channelLinkTokens).set({ usedAt: now }).where(eq(channelLinkTokens.tokenHash, match.tokenHash));
    // The user is checked again now: they may have been disabled or lost Ask OCSO since the page.
    const principal = await loadPrincipal(tx, match.claimedBy!, 'UI');
    const refusal = chatLinkRefusal(principal);
    if (!principal || refusal) return { kind: 'refused', reason: refusal ?? 'Your OCSO account is not active.' };
    const channel = await channelOf(tx, match.channelId);
    if (!channel) return { kind: 'refused', reason: 'This channel no longer exists.' };
    const identity = await identityRefusal(tx, match, principal.userId);
    if (identity.refusal) return { kind: 'refused', reason: identity.refusal };
    const [user] = await tx.select({ email: users.email }).from(users).where(eq(users.id, principal.userId));
    const [link] = await tx
      .insert(channelAccountLinks)
      .values({ id: uuidv7(), channelId: match.channelId, identityKind: match.identityKind, identityValue: match.identityValue, profileName: match.profileName, userId: principal.userId, authMethod: match.claimAuthMethod ?? 'password', createdAt: now })
      // A link made at the same moment from another token wins; this one is refused, never a second active link.
      .onConflictDoNothing()
      .returning();
    if (!link) return { kind: 'refused', reason: 'This chat account was just linked to an OCSO user.' };
    const shown = maskIdentity(`${match.identityKind}:${match.identityValue}`) ?? match.identityKind;
    await recordAudit(tx, { principal, correlationId: input.correlationId }, {
      action: 'channel.account_link',
      targetType: 'channel_account_link',
      targetId: link.id,
      summary: `Linked ${shown} on ${channel.name} to ${user?.email ?? principal.userId} for Ask OCSO (code confirmed from the chat account)`,
      after: { channelId: channel.id, channelKind: channel.kind, identityKind: match.identityKind, identity: shown, userId: principal.userId },
    });
    return { kind: 'linked', link };
  };
  return 'transaction' in db ? db.transaction(run) : run(db);
}

export async function listChatLinks(db: DbOrTx, userId: string, options: { includeRevoked?: boolean } = {}): Promise<ChatLinkView[]> {
  const rows = await db
    .select({ link: channelAccountLinks, channel: { id: channels.id, name: channels.name, kind: channels.kind } })
    .from(channelAccountLinks)
    .innerJoin(channels, eq(channels.id, channelAccountLinks.channelId))
    .where(and(eq(channelAccountLinks.userId, userId), options.includeRevoked ? undefined : isNull(channelAccountLinks.revokedAt)))
    .orderBy(desc(channelAccountLinks.createdAt))
    .limit(100);
  return rows.map(({ link, channel }) => view(link, channel));
}

function view(link: LinkRow, channel: { id: string; name: string; kind: string }): ChatLinkView {
  return {
    id: link.id,
    channel,
    identity: maskIdentity(`${link.identityKind}:${link.identityValue}`) ?? link.identityKind,
    profileName: link.profileName,
    userId: link.userId,
    createdAt: link.createdAt.toISOString(),
    lastUsedAt: link.lastUsedAt?.toISOString() ?? null,
    revokedAt: link.revokedAt?.toISOString() ?? null,
  };
}

/**
 * Revoke a link at once (a stop: never gated). The owner may revoke their own; anyone else needs users.manage.
 * Audited as `channel.account_unlink`. The chat identity gets a fresh link offer on its next message.
 */
export async function revokeChatLink(db: DbOrTx, actor: ActorContext, linkId: string, now = new Date()): Promise<ChatLinkView> {
  const principal = actor.principal;
  if (!principal) throw forbidden(Permission.USERS_MANAGE);
  const run = async (tx: DbOrTx): Promise<ChatLinkView> => {
    const [row] = await tx
      .select({ link: channelAccountLinks, channel: { id: channels.id, name: channels.name, kind: channels.kind }, email: users.email })
      .from(channelAccountLinks)
      .innerJoin(channels, eq(channels.id, channelAccountLinks.channelId))
      .innerJoin(users, eq(users.id, channelAccountLinks.userId))
      .where(eq(channelAccountLinks.id, linkId))
      .for('update', { of: channelAccountLinks });
    const own = row?.link.userId === principal.userId;
    // Someone else's link is not even acknowledged without users.manage.
    if (!row || (!own && !can(principal, Permission.USERS_MANAGE))) throw notFound('chat_link', linkId);
    if (row.link.revokedAt) return view(row.link, row.channel);
    const [done] = await tx.update(channelAccountLinks).set({ revokedAt: now }).where(and(eq(channelAccountLinks.id, linkId), isNull(channelAccountLinks.revokedAt))).returning();
    const shown = maskIdentity(`${row.link.identityKind}:${row.link.identityValue}`) ?? row.link.identityKind;
    await recordAudit(tx, actor, {
      action: 'channel.account_unlink',
      targetType: 'channel_account_link',
      targetId: linkId,
      summary: `Revoked the Ask OCSO link of ${shown} on ${row.channel.name} (${row.email})`,
      before: { channelId: row.channel.id, identity: shown, userId: row.link.userId },
    });
    return view(done ?? row.link, row.channel);
  };
  return 'transaction' in db ? db.transaction(run) : run(db);
}

/** Revoke every active link of a user (they were disabled). Returns how many were revoked. */
export async function revokeUserChatLinks(tx: DbOrTx, userId: string, now = new Date()): Promise<number> {
  const revoked = await tx
    .update(channelAccountLinks)
    .set({ revokedAt: now })
    .where(and(eq(channelAccountLinks.userId, userId), isNull(channelAccountLinks.revokedAt)))
    .returning({ id: channelAccountLinks.id });
  return revoked.length;
}

/** Record that a link was just used (the account page's "last used"). */
export async function touchChatLink(db: DbOrTx, linkId: string, now = new Date()): Promise<void> {
  await db.update(channelAccountLinks).set({ lastUsedAt: now }).where(eq(channelAccountLinks.id, linkId));
}
