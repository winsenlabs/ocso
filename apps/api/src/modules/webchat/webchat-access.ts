import { originAllowed, type EmbedWidgetConfig } from '@ocso/channels';
import { DomainError } from '@ocso/domain';

/**
 * Who may call the public web chat API (SPEC §C.3), as pure decisions:
 * - a browser call (Origin header) must come from OCSO itself (the widget
 *   iframe) or an allowed site (an empty allowlist = any site);
 * - a call without an Origin (native app, server) is accepted only when the
 *   channel allows native apps, or its auth mode is not anonymous (the
 *   session pass or verified user token is then the proof).
 */

export type AccessWidget = Pick<EmbedWidgetConfig, 'allowedOrigins' | 'authMode' | 'allowNativeApps'>;
export type OriginDecision = 'allowed' | 'not_allowed' | 'origin_required';

export function originDecision(origin: string | undefined, publicOrigin: string, widget: AccessWidget): OriginDecision {
  if (!origin) return widget.allowNativeApps || widget.authMode !== 'anonymous' ? 'allowed' : 'origin_required';
  if (origin === publicOrigin) return 'allowed';
  return widget.allowedOrigins.length === 0 || originAllowed(origin, widget.allowedOrigins) ? 'allowed' : 'not_allowed';
}

/** CORS: echo the origin only for allowed sites (any real site when the allowlist is empty; never the opaque `null`). */
export function corsOriginAllowed(origin: string, widget: Pick<EmbedWidgetConfig, 'allowedOrigins'>): boolean {
  return widget.allowedOrigins.length === 0 ? origin !== 'null' : originAllowed(origin, widget.allowedOrigins);
}

export function assertOriginAllowed(origin: string | undefined, publicOrigin: string, widget: AccessWidget): void {
  const decision = originDecision(origin, publicOrigin, widget);
  if (decision === 'not_allowed') throw new DomainError('authorization', 'webchat_origin_not_allowed', 'This site is not allowed to use this chat');
  if (decision === 'origin_required') {
    throw new DomainError('authorization', 'webchat_origin_required', 'This chat accepts calls from allowed websites only (enable native apps, or use a session pass)');
  }
}

/** Response headers for an allowed cross-origin call or preflight (bearer tokens only: never credentials). */
export const CORS_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-ocso-content-type',
  'Access-Control-Expose-Headers': 'Retry-After',
  'Access-Control-Max-Age': '600',
};
