import { z } from 'zod';
import { validation } from '@ocso/domain';
import type { WebChatContextSettings } from './auth-settings.js';

/**
 * Site-passed context (SPEC §C.4): flat key -> string | number | boolean.
 * Only allowlisted keys survive; the kept values must fit `maxBytes` of JSON.
 * Who vouched for them is recorded next to them: `host` (the site's backend,
 * via a session pass or a verified user token) or `client` (the browser).
 */

const MAX_VALUE_LENGTH = 1_024;
export const ContextValue = z.union([z.string().max(MAX_VALUE_LENGTH), z.number().finite(), z.boolean()]);
export const ContextValues = z.record(z.string().max(64), ContextValue).refine((v) => Object.keys(v).length <= 64, 'too many context keys');
export type ContextValues = Record<string, string | number | boolean>;

export type ContextSource = 'host' | 'client';

export interface WebChatContext {
  source: ContextSource;
  values: ContextValues;
  at: Date;
}

/** Keeps allowlisted keys with scalar values; throws a 400 when what is kept exceeds `maxBytes`. */
export function filterContext(raw: unknown, settings: WebChatContextSettings): ContextValues {
  if (raw === undefined || raw === null) return {};
  const parsed = ContextValues.safeParse(raw);
  if (!parsed.success) throw validation('webchat_context_invalid', 'context must be an object of string, number or boolean values');
  const allowed = new Set(settings.allow);
  const kept: ContextValues = {};
  for (const [key, value] of Object.entries(parsed.data)) if (allowed.has(key)) kept[key] = value;
  if (Buffer.byteLength(JSON.stringify(kept), 'utf8') > settings.maxBytes) {
    throw validation('webchat_context_too_large', `context exceeds ${settings.maxBytes} bytes`);
  }
  return kept;
}

/** Scalar claims of a verified user token whose names are allowlisted (e.g. `plan`, `tier`). */
export function contextFromClaims(claims: Readonly<Record<string, unknown>>, settings: WebChatContextSettings): ContextValues {
  const picked: Record<string, unknown> = {};
  for (const key of settings.allow) {
    const value = claims[key];
    if (ContextValue.safeParse(value).success) picked[key] = value;
  }
  return filterContext(picked, settings);
}
