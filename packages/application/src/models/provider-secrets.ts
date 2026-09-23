import type { SecretKind, SecretStore } from '@ocso/secrets';

/**
 * Credential values → SecretStore; the provider row keeps only
 * `{ credentialName: secretRef }` (ADR-012). Nothing here returns or logs values.
 */

/** Display-only classification for the secrets inventory. */
export function secretKindFor(credential: string): SecretKind {
  if (/api[-_]?key/i.test(credential)) return 'API_KEY';
  if (/serviceaccount/i.test(credential)) return 'SERVICE_ACCOUNT';
  if (/accesskey|secretaccesskey|sessiontoken/i.test(credential)) return 'IAM_CREDENTIALS';
  if (/client|tenant/i.test(credential)) return 'OAUTH_CLIENT';
  return 'OTHER';
}

export interface CredentialChange {
  /** The provider's secretRefs after the change. */
  refs: Record<string, string>;
  /** Refs created by this change: delete them if the database write fails. */
  created: string[];
  /** Refs no longer referenced: delete them after the database write commits. */
  released: string[];
  /** Credential names added, rotated or removed (for audit; names only). */
  changedKeys: string[];
}

export class ProviderCredentialStore {
  constructor(private readonly secrets: SecretStore) {}

  /** Store new credentials. On partial failure, already-created secrets are removed. */
  async store(providerName: string, values: Readonly<Record<string, string>>): Promise<CredentialChange> {
    return this.apply(providerName, {}, values);
  }

  /**
   * Apply a credential patch: every value is stored as a NEW secret (never a
   * rotation in place, which a failed or refused commit could not undo — the
   * replaced ref is released after the commit instead); `null` releases a credential.
   */
  async apply(
    providerName: string,
    current: Readonly<Record<string, string>>,
    patch: Readonly<Record<string, string | null>>,
  ): Promise<CredentialChange> {
    const change: CredentialChange = { refs: { ...current }, created: [], released: [], changedKeys: [] };
    try {
      for (const [key, value] of Object.entries(patch)) {
        const existing = current[key];
        if (value === null) {
          if (existing) {
            change.released.push(existing);
            delete change.refs[key];
            change.changedKeys.push(key);
          }
          continue;
        }
        const meta = await this.secrets.put({
          name: `${providerName} ${key}`,
          kind: secretKindFor(key),
          value,
          usedBy: `provider:${providerName}`,
        });
        change.refs[key] = meta.ref;
        change.created.push(meta.ref);
        if (existing) change.released.push(existing);
        change.changedKeys.push(key);
      }
    } catch (error) {
      await this.discard(change.created);
      throw error;
    }
    return change;
  }

  /** Best-effort delete (compensation / cleanup after commit). */
  async discard(refs: readonly string[]): Promise<void> {
    for (const ref of refs) await this.secrets.delete(ref).catch(() => {});
  }
}
