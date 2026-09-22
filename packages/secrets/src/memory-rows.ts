import type { SecretMetadata } from './contract.js';
import { toMetadata, type SecretRow, type SecretRowStore } from './local-store.js';

/** In-memory SecretRowStore for tests and ephemeral development only. */
export class InMemorySecretRows implements SecretRowStore {
  private readonly rows = new Map<string, SecretRow>();

  async insert(row: SecretRow): Promise<void> {
    if (this.rows.has(row.ref)) throw new Error(`secret ${row.ref} exists`);
    this.rows.set(row.ref, structuredClone(row));
  }

  async update(ref: string, patch: Pick<SecretRow, 'ciphertext' | 'rotatedAt' | 'version' | 'expiresAt'>): Promise<void> {
    const row = this.rows.get(ref);
    if (row) this.rows.set(ref, { ...row, ...structuredClone(patch) });
  }

  async get(ref: string): Promise<SecretRow | null> {
    const row = this.rows.get(ref);
    return row ? structuredClone(row) : null;
  }

  async list(): Promise<SecretMetadata[]> {
    return [...this.rows.values()].map(toMetadata);
  }

  async delete(ref: string): Promise<void> {
    this.rows.delete(ref);
  }

  /** Test helper: raw stored row (to assert values are not stored in plaintext). */
  raw(ref: string): SecretRow | undefined {
    return this.rows.get(ref);
  }
}
