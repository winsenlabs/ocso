import type { SecretRowStore } from './local-store.js';

/**
 * SecretStore contract (docs/archive/specs/15 §3, ADR-012). Every other table stores only a
 * secret reference. Values are resolved server-side by trusted code and are
 * never returned to browsers, prompts, logs, traces or audit payloads.
 */

export type SecretKind =
  | 'API_KEY'
  | 'IAM_CREDENTIALS'
  | 'SERVICE_ACCOUNT'
  | 'OAUTH_CLIENT'
  | 'OAUTH_TOKENS'
  | 'CHANNEL_TOKEN'
  | 'WEBHOOK_SECRET'
  | 'SIGNING_KEY'
  | 'OTHER';

export interface SecretMetadata {
  ref: string;
  name: string;
  kind: SecretKind;
  /** What uses it, e.g. "provider:AWS Bedrock". Display only. */
  usedBy: string | null;
  createdAt: string;
  rotatedAt: string | null;
  expiresAt: string | null;
  version: number;
}

export interface PutSecretInput {
  name: string;
  kind: SecretKind;
  value: string;
  usedBy?: string | null | undefined;
  expiresAt?: Date | null | undefined;
}

export interface SecretStore {
  /** Name of the driver that built it (SECRETS_DRIVER); display and logs only. */
  readonly driver: string;
  /** Create a secret and return its reference. */
  put(input: PutSecretInput): Promise<SecretMetadata>;
  /** Replace the value (rotation); bumps version. */
  rotate(ref: string, value: string, expiresAt?: Date | null): Promise<SecretMetadata>;
  /** Resolve the plaintext value. Trusted server-side code only. */
  resolve(ref: string): Promise<string>;
  describe(ref: string): Promise<SecretMetadata | null>;
  list(): Promise<SecretMetadata[]>;
  delete(ref: string): Promise<void>;
}

/**
 * A SecretStore driver: registered by name, selected by SECRETS_DRIVER.
 * `check` lists missing settings (start-up fails naming every one); `create`
 * builds the process-wide store over the metadata rows (the `secrets` table).
 */
export interface SecretStoreDriverDefinition<Env = Readonly<Record<string, unknown>>> {
  /** SECRETS_DRIVER value that selects this driver, e.g. `aws`. */
  readonly name: string;
  readonly check?: ((env: Env) => readonly string[]) | undefined;
  readonly create: (env: Env, deps: { rows: SecretRowStore }) => SecretStore;
}

/** Generate a secret reference like `sec_bdrk_4f81a2`. */
export function secretRef(hint: string, random: string): string {
  const slug = hint
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 6);
  return `sec_${slug || 'x'}_${random}`;
}
