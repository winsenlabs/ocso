import { INPUT_KINDS } from './types.js';

/** `{ key: value }` when defined, else `{}` (exactOptionalPropertyTypes-friendly spread). */
export const opt = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

export type InputKind = (typeof INPUT_KINDS)[number];
const KINDS = new Set<string>(INPUT_KINDS);
export const isInputKind = (k: string): k is InputKind => KINDS.has(k);

export const positiveInt = (n: unknown): number | undefined => (typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined);
