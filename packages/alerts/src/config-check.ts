import type { z } from 'zod';
import type { ConfigCheck } from './contract.js';

/** Run a zod schema over admin input and flatten issues into readable problems. */
export function checkConfig<S extends z.ZodType>(schema: S, input: unknown): ConfigCheck<z.output<S>> {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return { ok: true, config: parsed.data };
  return {
    ok: false,
    problems: parsed.error.issues.map((i) => (i.path.length ? `${i.path.map(String).join('.')}: ${i.message}` : i.message)),
  };
}

/** Problems for a URL that must be absolute https (webhook-style secrets and configs). */
export function httpsUrlProblems(value: string, label: string): string[] {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [`${label} must be a valid URL`];
  }
  if (url.protocol !== 'https:') return [`${label} must use https`];
  if (url.username || url.password) return [`${label} must not contain credentials`];
  return [];
}
