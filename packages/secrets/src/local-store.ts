import { randomBytes } from 'node:crypto';
import { notFound } from '@ocso/domain';
import { secretRef, type PutSecretInput, type SecretMetadata, type SecretStore } from './contract.js';
import { decrypt, encrypt, type Ciphertext, type MasterKey } from './envelope.js';

/** Persistence port implemented by the db package (`secrets` table). */
export interface SecretRow extends SecretMetadata {
  /** Local driver: encrypted value. AWS driver: null (value lives in Secrets Manager). */
  ciphertext: Ciphertext | null;
  /** AWS driver: Secrets Manager ARN. Local driver: null. */
  externalId: string | null;
}

export interface SecretRowStore {
  insert(row: SecretRow): Promise<void>;
  update(ref: string, patch: Pick<SecretRow, 'ciphertext' | 'rotatedAt' | 'version' | 'expiresAt'>): Promise<void>;
  get(ref: string): Promise<SecretRow | null>;
  list(): Promise<SecretMetadata[]>;
  delete(ref: string): Promise<void>;
}

/**
 * Local encrypted secret store for Compose deployments (ADR-012). Protects
 * database dumps and backups; it does not protect against a compromised host
 * that can read the master key file.
 */
export class LocalSecretStore implements SecretStore {
  readonly driver = 'local' as const;
  private readonly keys: Map<string, MasterKey>;

  constructor(
    private readonly rows: SecretRowStore,
    private readonly activeKey: MasterKey,
    retiredKeys: readonly MasterKey[] = [],
    private readonly now: () => Date = () => new Date(),
  ) {
    this.keys = new Map([activeKey, ...retiredKeys].map((k) => [k.id, k]));
  }

  async put(input: PutSecretInput): Promise<SecretMetadata> {
    const ref = secretRef(input.name, randomBytes(4).toString('hex'));
    const createdAt = this.now().toISOString();
    const meta: SecretMetadata = {
      ref,
      name: input.name,
      kind: input.kind,
      usedBy: input.usedBy ?? null,
      createdAt,
      rotatedAt: null,
      expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
      version: 1,
    };
    await this.rows.insert({ ...meta, ciphertext: encrypt(this.activeKey, input.value, ref), externalId: null });
    return meta;
  }

  async rotate(ref: string, value: string, expiresAt?: Date | null): Promise<SecretMetadata> {
    const row = await this.rows.get(ref);
    if (!row) throw notFound('secret', ref);
    const rotatedAt = this.now().toISOString();
    const next = {
      ciphertext: encrypt(this.activeKey, value, ref),
      rotatedAt,
      version: row.version + 1,
      expiresAt: expiresAt === undefined ? row.expiresAt : expiresAt ? expiresAt.toISOString() : null,
    };
    await this.rows.update(ref, next);
    return toMetadata({ ...row, ...next });
  }

  async resolve(ref: string): Promise<string> {
    const row = await this.rows.get(ref);
    if (!row?.ciphertext) throw notFound('secret', ref);
    return decrypt(this.keys, row.ciphertext, ref);
  }

  async describe(ref: string): Promise<SecretMetadata | null> {
    const row = await this.rows.get(ref);
    return row ? toMetadata(row) : null;
  }

  list(): Promise<SecretMetadata[]> {
    return this.rows.list();
  }

  delete(ref: string): Promise<void> {
    return this.rows.delete(ref);
  }
}

export function toMetadata(row: SecretRow): SecretMetadata {
  return {
    ref: row.ref,
    name: row.name,
    kind: row.kind,
    usedBy: row.usedBy,
    createdAt: row.createdAt,
    rotatedAt: row.rotatedAt,
    expiresAt: row.expiresAt,
    version: row.version,
  };
}
