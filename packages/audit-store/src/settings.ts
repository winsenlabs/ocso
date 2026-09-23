import { readFileSync } from 'node:fs';

/**
 * A setting given inline or as `<NAME>_FILE` (Compose secrets). The Compose
 * entrypoint already resolves the files it knows; this also covers processes
 * started without it (bins, local runs). A non-empty inline value wins.
 */
export function settingOrFile(value: string | undefined, file: string | undefined): string | undefined {
  if (value) return value;
  if (!file) return undefined;
  const content = readFileSync(file, 'utf8').trim();
  return content || undefined;
}

/** The user name and password carried by a connection URL. */
export function urlCredentials(url: string): { user: string; password: string } {
  const parsed = new URL(url);
  return { user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) };
}

/** A role or user name we can safely interpolate as an identifier. */
export const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
