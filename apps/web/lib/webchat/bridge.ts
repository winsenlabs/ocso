import { originAllowed, originOf } from './origins';

/**
 * Widget-side postMessage bridge to the host page (public/ocso-webchat.js).
 * Security rules (docs/15): accept commands only from the parent window AND
 * the verified host origin; post only to that exact origin (never "*"); when
 * the channel has an allowlist, a host outside it gets no bridge at all.
 */

export const HOST_SOURCE = 'ocso-webchat-host';
export const WIDGET_SOURCE = 'ocso-webchat';
export const PROTOCOL_VERSION = 1;

export type HostCommand =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'reset' }
  | { type: 'identify'; token: string; requestId: string | null };

export type WidgetEvent =
  | { type: 'ready'; branding: { accentColor: string | null; position: 'left' | 'right'; launcherLabel: string | null; title: string } }
  | { type: 'unread'; count: number }
  | { type: 'close' }
  | { type: 'identified'; ok: boolean; requestId: string | null; error?: string };

export interface HostOriginInput {
  framed: boolean;
  /** `?host=` set by the loader (a hint; verified below). */
  hostParam: string | null;
  ancestorOrigins: readonly string[] | null;
  referrer: string;
  allowedOrigins: readonly string[];
}

export type HostOriginResult =
  | { ok: true; origin: string }
  | { ok: false; reason: 'standalone' | 'unknown' | 'mismatch' | 'not_allowed' };

export function resolveHostOrigin(input: HostOriginInput): HostOriginResult {
  if (!input.framed) return { ok: false, reason: 'standalone' };
  const ancestor = input.ancestorOrigins?.[0] ?? null;
  const claimed = originOf(input.hostParam) ?? ancestor ?? originOf(input.referrer);
  if (!claimed) return { ok: false, reason: 'unknown' };
  if (ancestor && ancestor !== claimed) return { ok: false, reason: 'mismatch' };
  if (input.allowedOrigins.length > 0 && !originAllowed(claimed, input.allowedOrigins)) return { ok: false, reason: 'not_allowed' };
  return { ok: true, origin: claimed };
}

export interface IncomingMessage {
  origin: string;
  source: unknown;
  data: unknown;
}

/** A validated host command, or null when the message must be ignored. */
export function parseHostMessage(event: IncomingMessage, hostOrigin: string, parent: unknown): HostCommand | null {
  if (event.origin !== hostOrigin || event.source !== parent || parent == null) return null;
  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data !== 'object' || data['source'] !== HOST_SOURCE || data['v'] !== PROTOCOL_VERSION) return null;
  switch (data['type']) {
    case 'open':
    case 'close':
    case 'reset':
      return { type: data['type'] };
    case 'identify': {
      const token = data['token'];
      if (typeof token !== 'string' || token.length < 10 || token.length > 4096) return null;
      const requestId = typeof data['requestId'] === 'string' ? data['requestId'].slice(0, 64) : null;
      return { type: 'identify', token, requestId };
    }
    default:
      return null;
  }
}

export interface HostBridge {
  post(event: WidgetEvent): void;
  dispose(): void;
}

/** Wire the bridge on `win` (the widget iframe's window). */
export function createHostBridge(win: Window, hostOrigin: string, onCommand: (command: HostCommand) => void): HostBridge {
  const listener = (event: MessageEvent) => {
    const command = parseHostMessage(event, hostOrigin, win.parent);
    if (command) onCommand(command);
  };
  win.addEventListener('message', listener);
  return {
    post(event) {
      win.parent.postMessage({ source: WIDGET_SOURCE, v: PROTOCOL_VERSION, ...event }, hostOrigin);
    },
    dispose() {
      win.removeEventListener('message', listener);
    },
  };
}
