import { ROLE_LABELS, type Role } from '@ocso/auth';
import { recordAudit } from '../audit/audit.js';
import type { ActorContext } from '../shared/context.js';
import type { AuthMailer, MailOutcome } from './auth-mailer.js';

/** What the create call did about the new user's first sign-in. */
export type Onboarding =
  | { kind: 'password' }
  | { kind: 'invite'; expiresAt: string; delivery: MailOutcome; /** Only for EMAIL_DRIVER=log: the admin shares it. */ link: string | null }
  /** Created inert: the invite (or password sign-in) starts once the user's creation is approved. */
  | { kind: 'pending_approval' };

export const DEFAULT_INVITE_TTL_HOURS = 72;
/** Admin-initiated reset links are handed over by a person, so they live longer than self-service ones (1 h). */
export const ADMIN_RESET_TTL_HOURS = 24;

/** Email an invite link (or hand it back for the log driver) and audit the attempt. */
export async function deliverInvite(
  db: Parameters<typeof recordAudit>[0],
  mailer: AuthMailer,
  actor: ActorContext,
  user: { id: string; email: string; name: string; role: Role },
  token: { token: string; expiresAt: Date },
  action: 'user.invite_sent' | 'user.invite_resent',
): Promise<Onboarding> {
  const delivery = await mailer.sendInvite({
    to: user.email,
    name: user.name,
    roleLabel: ROLE_LABELS[user.role],
    inviterName: actor.principal?.displayName ?? 'Your administrator',
    token: token.token,
    expiresAt: token.expiresAt,
  });
  await recordAudit(db, actor, {
    action,
    targetType: 'user',
    targetId: user.id,
    summary: delivery.delivered
      ? `Invite ${mailer.delivers ? 'emailed' : 'written to the log driver'} for ${user.email} (expires ${token.expiresAt.toISOString()})`
      : `Invite for ${user.email} could not be emailed: ${delivery.error}`,
  });
  // The log driver delivers nothing: the admin gets the link to share it out of band.
  return { kind: 'invite', expiresAt: token.expiresAt.toISOString(), delivery, link: mailer.delivers ? null : mailer.link('/invite', token.token) };
}
