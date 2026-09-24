import 'server-only';
import { z } from 'zod';
import { api } from './client';

/**
 * Chat account links (Ask OCSO over Slack and Teams): the `/link/<token>` page's preview and confirm, the signed-in
 * user's links (Account) and, for a Tech admin with users.manage, a user's links (Team). The token goes in the body.
 */

export const ChatLinkSchema = z.object({
  id: z.string(),
  channel: z.object({ id: z.string(), name: z.string(), kind: z.string() }),
  identity: z.string(),
  profileName: z.string().nullable(),
  userId: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  network: z.string(),
});
export type ChatLink = z.infer<typeof ChatLinkSchema>;

export const LinkPreviewSchema = z.object({
  state: z.enum(['valid', 'expired', 'used', 'invalid']),
  channel: z.object({ id: z.string(), name: z.string(), kind: z.string() }).optional(),
  identity: z.string().optional(),
  account: z.string().optional(),
  profileName: z.string().nullish(),
  refusal: z.string().nullable(),
  alreadyLinked: z.boolean(),
  network: z.string().nullable(),
  you: z.object({ name: z.string(), email: z.string() }).nullable(),
});
export type LinkPreview = z.infer<typeof LinkPreviewSchema>;

export function previewChatLink(token: string): Promise<LinkPreview> {
  return api.post('/v1/internal-agent/link-tokens/preview', { token }, LinkPreviewSchema);
}

const ConfirmSchema = z.object({ link: ChatLinkSchema.nullable(), existing: z.boolean(), code: z.string().nullish(), expiresAt: z.string().nullish() });
export type ConfirmedChatLink = z.infer<typeof ConfirmSchema>;

/** Claims the link: returns the code to send from the chat account (or `existing` when it was already linked to you). */
export function confirmChatLink(token: string): Promise<ConfirmedChatLink> {
  return api.post('/v1/internal-agent/link-tokens/confirm', { token }, ConfirmSchema);
}

export function listMyChatLinks(): Promise<ChatLink[]> {
  return api.get('/v1/internal-agent/chat-links', z.array(ChatLinkSchema));
}

export function listUserChatLinks(userId: string): Promise<ChatLink[]> {
  return api.get(`/v1/internal-agent/users/${encodeURIComponent(userId)}/chat-links`, z.array(ChatLinkSchema));
}

export function revokeChatLink(id: string): Promise<ChatLink> {
  return api.post(`/v1/internal-agent/chat-links/${encodeURIComponent(id)}/revoke`, {}, ChatLinkSchema);
}
