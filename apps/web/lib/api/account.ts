import 'server-only';
import { z } from 'zod';
import { callAuth } from '../auth/better-auth';

/**
 * Better Auth reads for Account security (GET /api/auth/list-sessions and
 * /passkey/list-user-passkeys, session as Bearer). Session tokens are dropped
 * here: they never reach a component or the browser.
 */
const SessionRow = z.object({
  id: z.string(),
  createdAt: z.coerce.date(),
  expiresAt: z.coerce.date(),
  ipAddress: z.string().nullish(),
  userAgent: z.string().nullish(),
  authMethod: z.string().nullish(),
});
export type SessionRow = z.infer<typeof SessionRow>;

const PasskeyRow = z.object({
  id: z.string(),
  name: z.string().nullish(),
  createdAt: z.coerce.date().nullish(),
  deviceType: z.string().nullish(),
  backedUp: z.boolean().nullish(),
});
export type PasskeyRow = z.infer<typeof PasskeyRow>;

export async function listMySessions(): Promise<SessionRow[]> {
  const res = await callAuth<unknown>('/list-sessions', undefined, { method: 'GET', session: true, relay: false });
  const parsed = z.array(SessionRow).safeParse(res.data);
  return parsed.success ? parsed.data.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()) : [];
}

export async function listMyPasskeys(): Promise<PasskeyRow[]> {
  const res = await callAuth<unknown>('/passkey/list-user-passkeys', undefined, { method: 'GET', session: true, relay: false });
  const parsed = z.array(PasskeyRow).safeParse(res.data);
  return parsed.success ? parsed.data : [];
}
