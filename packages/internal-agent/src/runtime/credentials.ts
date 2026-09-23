import { DomainError, validation } from '@ocso/domain';
import type { Capability, CredentialInput } from '../catalog/index.js';
import type { SplitArgs } from './args.js';
import { get, record } from './snapshot.js';
import type { CardContext } from './cards.js';
import type { CardCredentialField, RevealedSecret } from './types.js';

/**
 * Credentials on the confirmation card (PM/research/12 §9). The model passes the non-secret arguments only; the card
 * lists the credential fields the route takes (from the capability, or for a map field from the channel / provider
 * kind's descriptor, read as the user), and the user types the values into the card's own password fields. The
 * values travel in the confirm request, go into the route's body for that one in-process call, and are never
 * stored: not in the card, the thread, the action row, the audit row or an error message.
 */

/** A card field and where its value goes in the route's body. */
export interface ResolvedCredential extends CardCredentialField {
  field: string;
  shape: 'map' | 'value';
}

const KINDS_PATH: Record<'channel_kind' | 'provider_kind', string> = { channel_kind: '/v1/channels/kinds', provider_kind: '/v1/model-providers/kinds' };
const NOUN: Record<'channel_kind' | 'provider_kind', string> = { channel_kind: 'channel kind', provider_kind: 'model provider kind' };

interface ChannelSecretDescriptor {
  key: string;
  label: string;
  required: boolean;
  hint?: string;
  generate?: 'server' | 'client';
}
interface ProviderFieldDescriptor {
  name: string;
  label: string;
  required: boolean;
  description?: string;
}

/**
 * The credential fields a write's card asks for, in order. A create lists the kind's fields as the create form does
 * (a server-generated one is optional: "leave blank to generate"); an edit lists them all as optional (blank keeps
 * the stored value). Throws when the kind or its fields cannot be read as this user: no card without its fields.
 */
export async function credentialFields(ctx: CardContext, capability: Capability, split: SplitArgs, current: Record<string, unknown> | null): Promise<ResolvedCredential[]> {
  const specs = capability.credentials ?? [];
  if (!specs.length) return [];
  const create = capability.method === 'POST';
  const out: ResolvedCredential[] = [];
  for (const spec of specs) out.push(...(await fieldsOf(ctx, spec, split, current, create)));
  const keys = out.map((f) => f.key);
  if (new Set(keys).size !== keys.length) throw new DomainError('validation', 'credential_fields_ambiguous', `${capability.name} has two credential fields with one name; make this change in OCSO directly.`);
  return out;
}

async function fieldsOf(ctx: CardContext, spec: CredentialInput, split: SplitArgs, current: Record<string, unknown> | null, create: boolean): Promise<ResolvedCredential[]> {
  if (spec.shape === 'value') {
    return [{ key: spec.field, label: spec.label, ...(spec.hint ? { hint: spec.hint } : {}), required: spec.required, field: spec.field, shape: 'value' }];
  }
  const kind = typeof split.body?.['kind'] === 'string' ? split.body['kind'] : typeof current?.['kind'] === 'string' ? current['kind'] : null;
  if (!kind) throw validation('invalid_tool_arguments', `kind is needed so the card can ask for the ${NOUN[spec.source]}'s credentials`);
  const res = await get(ctx, KINDS_PATH[spec.source]);
  if (res.status >= 400) throw new DomainError('validation', 'credential_fields_unreadable', `Ask OCSO cannot read which credentials a ${kind} ${NOUN[spec.source]} takes, so it makes no card. Make this change in OCSO directly.`);
  const kinds = Array.isArray(res.body) ? res.body : [];
  const descriptor = kinds.map(record).find((d) => d?.['kind'] === kind);
  if (!descriptor) throw validation('invalid_tool_arguments', `${kind} is not a ${NOUN[spec.source]} of this deployment (see ${spec.source === 'channel_kind' ? 'channels.list_channel_kinds' : 'models.list_provider_kinds'})`);
  const keep = create ? '' : ' Leave blank to keep the current value.';
  if (spec.source === 'channel_kind') {
    const secrets = (Array.isArray(descriptor['secrets']) ? descriptor['secrets'] : []) as ChannelSecretDescriptor[];
    return secrets.map((s) => {
      const generate = create && s.generate === 'server';
      const hint = `${s.hint ?? ''}${keep}`.trim();
      return { key: s.key, label: s.label, ...(hint ? { hint } : {}), required: create && s.required && !generate, ...(generate ? { generate: true } : {}), field: spec.field, shape: 'map' as const };
    });
  }
  const fields = (Array.isArray(descriptor['credentials']) ? descriptor['credentials'] : []) as ProviderFieldDescriptor[];
  return fields.map((f) => {
    const hint = `${f.description ?? ''}${keep}`.trim();
    return { key: f.name, label: f.label, ...(hint ? { hint } : {}), required: create && f.required, field: spec.field, shape: 'map' as const };
  });
}

/** The card's view of the fields (no body mapping). */
export function cardFields(fields: readonly ResolvedCredential[]): CardCredentialField[] {
  return fields.map(({ field: _field, shape: _shape, ...f }) => f);
}

/**
 * The values the user typed, checked against the card's fields: every key must be one of them, every required one
 * filled. Blank values are dropped (a generated or kept value). Messages name fields, never values.
 */
export function checkCredentials(fields: readonly ResolvedCredential[], input: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const given = Object.entries(input ?? {}).filter(([, v]) => typeof v === 'string' && v.trim() !== '');
  if (given.length && !fields.length) throw validation('unexpected_credentials', 'This card takes no credentials.');
  const known = new Set(fields.map((f) => f.key));
  const unknown = given.map(([k]) => k).filter((k) => !known.has(k));
  if (unknown.length) throw validation('unknown_credential', `This card has no credential field ${unknown.map((k) => k.slice(0, 80)).join(', ')}.`);
  const values = Object.fromEntries(given);
  const missing = fields.filter((f) => f.required && !values[f.key]);
  if (missing.length) throw validation('credential_required', `Enter ${missing.map((f) => f.label).join(', ')} on the card.`);
  return values;
}

/** The route's body with the typed values in their fields (a map field merges into what the args already hold). */
export function withCredentials(body: Record<string, unknown> | undefined, fields: readonly ResolvedCredential[], values: Readonly<Record<string, string>>): Record<string, unknown> | undefined {
  if (!Object.keys(values).length) return body;
  const next: Record<string, unknown> = { ...(body ?? {}) };
  for (const f of fields) {
    const value = values[f.key];
    if (value === undefined) continue;
    if (f.shape === 'value') next[f.field] = value;
    else next[f.field] = { ...(record(next[f.field]) ?? {}), [f.key]: value };
  }
  return next;
}

/** Secrets the route generated and returns once (`revealResponse`), labelled from the card's fields. */
export function revealedSecrets(capability: Capability, body: unknown, fields: readonly CardCredentialField[]): RevealedSecret[] {
  if (!capability.revealResponse) return [];
  const map = record(record(body)?.[capability.revealResponse]);
  if (!map) return [];
  return Object.entries(map).flatMap(([key, value]) => (typeof value === 'string' && value ? [{ key, label: fields.find((f) => f.key === key)?.label ?? key, value }] : []));
}

const REDACTED = '[redacted]';

/**
 * A copy of `value` with every occurrence of the given secrets replaced (strings at any depth, and object keys).
 * Applied to whatever a confirm stores or answers besides the reveal: route errors, results, failure messages.
 */
export function scrubSecrets<T>(value: T, secrets: readonly string[]): T {
  const list = secrets.filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  if (!list.length) return value;
  const text = (s: string) => list.reduce((acc, secret) => acc.split(secret).join(REDACTED), s);
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return text(v);
    if (depth > 20 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [text(k), walk(x, depth + 1)]));
  };
  return walk(value, 0) as T;
}
