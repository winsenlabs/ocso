/**
 * SecretStore contract (docs/15 §3, ADR-012). Every other table stores only a
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
  readonly driver: 'local' | 'aws';
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

/** Generate a secret reference like `sec_bdrk_4f81a2`. */
export function secretRef(hint: string, random: string): string {
  const slug = hint
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 6);
  return `sec_${slug || 'x'}_${random}`;
}
