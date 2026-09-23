import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { ActorContext } from '@ocso/application';
import { channels } from '@ocso/db';
import type { SeedContext } from '../context.js';
import { approveAs, isApproved } from './agents.js';

export const WEBCHAT_NAME = 'Meridian web chat';

/**
 * The demo web chat channel. Its visitor-token secret is generated here and
 * handed to ChannelService, which stores it in the SecretStore; only the
 * reference is persisted and the value is never printed.
 */
/** The channel only; who answers is its router (seed steps/routers.ts). */
export async function seedWebChat(ctx: SeedContext, admin: ActorContext, checker: ActorContext): Promise<{ id: string; publicKey: string }> {
  const [existing] = await ctx.db.select({ id: channels.id, publicKey: channels.publicKey }).from(channels).where(eq(channels.name, WEBCHAT_NAME));
  if (existing) {
    // Created by an interrupted run before its activation was approved.
    if (!(await isApproved(ctx, 'channel', existing.id))) {
      await approveAs(ctx, admin, checker, { objectKind: 'channel', objectId: existing.id, action: 'ACTIVATE' }, 'Demo seed: open the web chat channel');
    }
    return existing;
  }
  const view = await ctx.services.channels.create(admin, {
    kind: 'WEBCHAT',
    name: WEBCHAT_NAME,
    settings: { visitorTokenTtlSeconds: 30 * 86_400, maxAttachmentsPerMessage: 5 },
    secrets: { visitorTokenSecret: randomBytes(48).toString('base64url') },
    status: 'DRAFT',
  });
  // Activation is approved by a Head (approvals.check.channels), never by the Tech admin who made it.
  await approveAs(ctx, admin, checker, { objectKind: 'channel', objectId: view.id, action: 'ACTIVATE' }, 'Demo seed: open the web chat channel');
  ctx.log(`created WEBCHAT channel "${WEBCHAT_NAME}" (public key ${view.publicKey}), activated with approval`);
  return { id: view.id, publicKey: view.publicKey };
}
