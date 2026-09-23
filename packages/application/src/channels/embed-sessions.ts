import { and, desc, eq, gt, lte } from 'drizzle-orm';
import { conversations, uuidv7, webchatSessionPassUses, webchatUserTokens, type Db, type DbOrTx } from '@ocso/db';
import { resolveCustomer, type IdentityClaim } from '../customers/identity-resolver.js';

/**
 * Server-side state of embeddable-channel sessions (SPEC §C): single-use
 * session-pass ids, and end-user tokens held (sealed by the channel kind) for
 * agent tool calls when the channel passes user tokens through. Values are
 * opaque here: this module never sees a plaintext token.
 */

/** Records a pass id until it expires; false when it was already used (replay). */
export async function consumeSessionPassId(db: DbOrTx, channelId: string, jti: string, expiresAt: Date): Promise<boolean> {
  const inserted = await db.insert(webchatSessionPassUses).values({ jti, channelId, expiresAt }).onConflictDoNothing().returning({ jti: webchatSessionPassUses.jti });
  return inserted.length === 1;
}

export interface HeldUserTokenInput {
  channelId: string;
  /** Who the token belongs to, in inbound identity terms (the customer is created when new, as ingress would). */
  identity: { identityKind: string; identityValue: string; alternateIdentities: readonly IdentityClaim[]; profileName?: string | undefined };
  visitorId?: string | undefined;
  sealed: string;
  expiresAt: Date;
  now: Date;
}

/** Keep a sealed user token for the customer behind `identity`; returns the customer id. */
export async function holdUserToken(db: Db, input: HeldUserTokenInput): Promise<string> {
  return db.transaction(async (tx) => {
    const customer = await resolveCustomer(tx, {
      primary: { kind: input.identity.identityKind, value: input.identity.identityValue },
      alternates: input.identity.alternateIdentities,
      profileName: input.identity.profileName,
      primaryVerified: true,
      now: input.now,
    });
    await tx.insert(webchatUserTokens).values({
      id: uuidv7(),
      channelId: input.channelId,
      customerId: customer.customerId,
      visitorId: input.visitorId ?? null,
      tokenCiphertext: input.sealed,
      expiresAt: input.expiresAt,
    });
    return customer.customerId;
  });
}

/** The newest live sealed token for a conversation's customer on its channel, with the channel it belongs to. */
export async function heldUserTokenFor(db: DbOrTx, conversationId: string, now: Date): Promise<{ channelId: string; sealed: string } | null> {
  const [row] = await db
    .select({ channelId: webchatUserTokens.channelId, sealed: webchatUserTokens.tokenCiphertext })
    .from(conversations)
    .innerJoin(webchatUserTokens, and(eq(webchatUserTokens.customerId, conversations.customerId), eq(webchatUserTokens.channelId, conversations.channelId)))
    .where(and(eq(conversations.id, conversationId), gt(webchatUserTokens.expiresAt, now)))
    .orderBy(desc(webchatUserTokens.createdAt))
    .limit(1);
  return row ?? null;
}

/** Deletes expired held tokens and pass ids (scheduled). */
export async function sweepEmbedSessions(db: DbOrTx, now: Date = new Date()): Promise<{ userTokens: number; passIds: number }> {
  const tokens = await db.delete(webchatUserTokens).where(lte(webchatUserTokens.expiresAt, now)).returning({ id: webchatUserTokens.id });
  const passes = await db.delete(webchatSessionPassUses).where(lte(webchatSessionPassUses.expiresAt, now)).returning({ jti: webchatSessionPassUses.jti });
  return { userTokens: tokens.length, passIds: passes.length };
}
