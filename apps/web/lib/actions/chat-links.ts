'use server';

import { refresh } from 'next/cache';
import { z } from 'zod';
import { describeApiError } from '../api/errors';
import { confirmChatLink, revokeChatLink } from '../api/chat-links';
import { getSession } from '../session';

export type ChatLinkResult = { ok: true; message: string; code?: string | undefined } | { ok: false; message: string };

const Token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** Claim the one-time link for the signed-in user (POST …/link-tokens/confirm): the code to send from chat, or already linked. */
export async function confirmChatLinkAction(token: string): Promise<ChatLinkResult> {
  if (!Token.safeParse(token).success) return { ok: false, message: 'This link is incomplete. Send the app a new message to get a fresh one.' };
  if (!(await getSession())) return { ok: false, message: 'Your session has ended. Sign in again.' };
  try {
    const done = await confirmChatLink(token);
    if (done.code) return { ok: true, code: done.code, message: 'Send this code to the app from your own chat account to finish linking. It works for 10 minutes.' };
    return { ok: true, message: 'This chat account was already linked to you. You can ask Ask OCSO there.' };
  } catch (err) {
    return { ok: false, message: describeApiError(err) };
  }
}

/** Revoke a chat account link at once (your own, or a colleague's with users.manage). */
export async function revokeChatLinkAction(id: string): Promise<ChatLinkResult> {
  if (!z.uuid().safeParse(id).success) return { ok: false, message: 'Unknown link' };
  if (!(await getSession())) return { ok: false, message: 'Your session has ended. Sign in again.' };
  try {
    await revokeChatLink(id);
    refresh();
    return { ok: true, message: 'Link revoked.' };
  } catch (err) {
    return { ok: false, message: describeApiError(err) };
  }
}
