import type { CapabilityKey, Profile, ProfileInput } from '../../../lib/api/models';

/**
 * Logical model profile dialog state ↔ API input (POST/PATCH
 * /v1/model-profiles). Inputs are kept as strings while editing; conversion
 * and range checks happen here so the dialog and its tests share them.
 */

export interface TargetRow {
  key: string;
  providerId: string;
  model: string;
}

export type Reasoning = '' | 'none' | 'low' | 'medium' | 'high';

export interface ProfileFormState {
  name: string;
  description: string;
  providerId: string;
  model: string;
  fallbacks: TargetRow[];
  temperature: string;
  maxOutputTokens: string;
  reasoning: Reasoning;
  timeoutSeconds: string;
  retries: string;
  retryBackoffMs: string;
  cachePolicy: 'OFF' | 'PREFIX';
  cacheTtl: '' | '5m' | '1h';
  capabilities: Partial<Record<CapabilityKey, boolean>>;
}

export const PROFILE_NAME = /^[a-z][a-z0-9-]{1,48}$/;
export const MAX_FALLBACKS = 5;

let keySeq = 0;
export const newTargetKey = (): string => `t${++keySeq}`;

type ProfileSource = Pick<
  Profile,
  | 'name'
  | 'description'
  | 'providerId'
  | 'model'
  | 'fallbacks'
  | 'temperature'
  | 'maxOutputTokens'
  | 'reasoning'
  | 'timeoutMs'
  | 'retries'
  | 'retryBackoffMs'
  | 'cachePolicy'
  | 'cacheTtl'
  | 'requiredCapabilities'
>;

/** Defaults mirror the API's ProfileInput defaults. */
export function initialProfileForm(profile: ProfileSource | null, defaultProviderId: string): ProfileFormState {
  if (!profile) {
    return {
      name: '',
      description: '',
      providerId: defaultProviderId,
      model: '',
      fallbacks: [],
      temperature: '',
      maxOutputTokens: '1024',
      reasoning: '',
      timeoutSeconds: '30',
      retries: '1',
      retryBackoffMs: '400',
      cachePolicy: 'PREFIX',
      cacheTtl: '',
      capabilities: {},
    };
  }
  return {
    name: profile.name,
    description: profile.description ?? '',
    providerId: profile.providerId,
    model: profile.model,
    fallbacks: profile.fallbacks.map((f) => ({ key: newTargetKey(), providerId: f.providerId, model: f.model })),
    temperature: profile.temperature === null ? '' : String(profile.temperature),
    maxOutputTokens: String(profile.maxOutputTokens),
    reasoning: profile.reasoning ?? '',
    timeoutSeconds: String(profile.timeoutMs / 1000),
    retries: String(profile.retries),
    retryBackoffMs: String(profile.retryBackoffMs),
    cachePolicy: profile.cachePolicy,
    cacheTtl: profile.cacheTtl ?? '',
    capabilities: { ...profile.requiredCapabilities },
  };
}

function num(raw: string, { min, max, int }: { min: number; max: number; int: boolean }): number | string {
  const value = Number(raw.trim());
  if (raw.trim() === '' || !Number.isFinite(value)) return 'Enter a number';
  if (int && !Number.isInteger(value)) return 'Enter a whole number';
  if (value < min || value > max) return `Between ${min} and ${max}`;
  return value;
}

export type ProfileFormResult = { ok: true; input: ProfileInput } | { ok: false; errors: Record<string, string> };

/** Form → API input, with per-field messages keyed by form field name. */
export function toProfileInput(state: ProfileFormState): ProfileFormResult {
  const errors: Record<string, string> = {};
  const name = state.name.trim();
  if (!PROFILE_NAME.test(name)) errors['name'] = 'lowercase letters, digits and dashes; starts with a letter; 2–49 characters';
  if (!state.providerId) errors['providerId'] = 'Choose a provider';
  if (!state.model.trim()) errors['model'] = 'Enter the model or deployment id';

  const temperature = state.temperature.trim() === '' ? null : num(state.temperature, { min: 0, max: 2, int: false });
  const maxOutputTokens = num(state.maxOutputTokens, { min: 1, max: 200_000, int: true });
  const timeoutSeconds = num(state.timeoutSeconds, { min: 1, max: 600, int: false });
  const retries = num(state.retries, { min: 0, max: 5, int: true });
  const retryBackoffMs = num(state.retryBackoffMs, { min: 0, max: 60_000, int: true });
  for (const [field, value] of Object.entries({ temperature, maxOutputTokens, timeoutSeconds, retries, retryBackoffMs })) {
    if (typeof value === 'string') errors[field] = value;
  }

  const fallbacks = state.fallbacks.map((f) => ({ providerId: f.providerId, model: f.model.trim() }));
  if (fallbacks.length > MAX_FALLBACKS) errors['fallbacks'] = `At most ${MAX_FALLBACKS} fallback targets`;
  else if (fallbacks.some((f) => !f.providerId || !f.model)) errors['fallbacks'] = 'Every fallback needs a provider and a model';
  else {
    const seen = new Set([`${state.providerId} ${state.model.trim()}`]);
    for (const f of fallbacks) {
      const key = `${f.providerId} ${f.model}`;
      if (seen.has(key)) errors['fallbacks'] = `Target ${f.model} is listed more than once`;
      seen.add(key);
    }
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  const capabilities = Object.fromEntries(Object.entries(state.capabilities).filter(([, on]) => on === true)) as Partial<Record<CapabilityKey, boolean>>;
  return {
    ok: true,
    input: {
      name,
      description: state.description.trim() || null,
      providerId: state.providerId,
      model: state.model.trim(),
      temperature: temperature as number | null,
      maxOutputTokens: maxOutputTokens as number,
      reasoning: state.reasoning || null,
      timeoutMs: Math.round((timeoutSeconds as number) * 1000),
      retries: retries as number,
      retryBackoffMs: retryBackoffMs as number,
      cachePolicy: state.cachePolicy,
      cacheTtl: state.cacheTtl || null,
      fallbacks,
      requiredCapabilities: capabilities,
    },
  };
}

/** Move a fallback up (-1) or down (+1) in the ordered list. */
export function moveTarget(rows: readonly TargetRow[], index: number, delta: -1 | 1): TargetRow[] {
  const to = index + delta;
  if (to < 0 || to >= rows.length) return [...rows];
  const next = [...rows];
  const [row] = next.splice(index, 1);
  next.splice(to, 0, row!);
  return next;
}
