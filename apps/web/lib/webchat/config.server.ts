import 'server-only';
import { headers } from 'next/headers';
import { api } from '../api/client';
import { ocsoOrigin } from './ocso-origin';
import { WebChatConfig } from './types';

/**
 * Public widget configuration for a channel (server-side, no staff session).
 * Returns null when the key is unknown/disabled or the API is unreachable, so
 * the page renders an honest "unavailable" state instead of an error page.
 */
export async function loadWidgetConfig(publicKey: string): Promise<WebChatConfig | null> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(publicKey)) return null;
  try {
    const origin = ocsoOrigin(await headers());
    return await api.get(`/public/webchat/${encodeURIComponent(publicKey)}/config`, WebChatConfig, { token: null, timeoutMs: 5_000, headers: origin ? { origin } : {} });
  } catch {
    return null;
  }
}
