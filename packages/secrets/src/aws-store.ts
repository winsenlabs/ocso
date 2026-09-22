import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  type SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { randomBytes } from 'node:crypto';
import { notFound } from '@ocso/domain';
import { secretRef, type PutSecretInput, type SecretMetadata, type SecretStore } from './contract.js';
import { toMetadata, type SecretRowStore } from './local-store.js';

export interface AwsSecretStoreOptions {
  /** Name prefix restricted by IAM, e.g. `ocso/prod`. */
  namePrefix: string;
  kmsKeyId?: string | undefined;
  /** In-process cache TTL for resolved values (no official Node caching client exists). */
  cacheTtlMs?: number | undefined;
  recoveryWindowDays?: number | undefined;
}

/**
 * AWS Secrets Manager driver (ADR-012, research/05 §4). Values live in Secrets
 * Manager; PostgreSQL keeps metadata and the ARN only.
 */
export class AwsSecretStore implements SecretStore {
  readonly driver = 'aws' as const;
  private readonly cache = new Map<string, { value: string; expires: number }>();

  constructor(
    private readonly client: SecretsManagerClient,
    private readonly rows: SecretRowStore,
    private readonly options: AwsSecretStoreOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async put(input: PutSecretInput): Promise<SecretMetadata> {
    const ref = secretRef(input.name, randomBytes(4).toString('hex'));
    const created = await this.client.send(
      new CreateSecretCommand({
        Name: `${this.options.namePrefix}/${ref}`,
        SecretString: input.value,
        KmsKeyId: this.options.kmsKeyId,
        Description: `OCSO ${input.kind} secret`,
        Tags: [
          { Key: 'ocso:ref', Value: ref },
          { Key: 'ocso:kind', Value: input.kind },
        ],
      }),
    );
    const meta: SecretMetadata = {
      ref,
      name: input.name,
      kind: input.kind,
      usedBy: input.usedBy ?? null,
      createdAt: this.now().toISOString(),
      rotatedAt: null,
      expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
      version: 1,
    };
    await this.rows.insert({ ...meta, ciphertext: null, externalId: created.ARN ?? null });
    return meta;
  }

  async rotate(ref: string, value: string, expiresAt?: Date | null): Promise<SecretMetadata> {
    const row = await this.rows.get(ref);
    if (!row?.externalId) throw notFound('secret', ref);
    await this.client.send(new PutSecretValueCommand({ SecretId: row.externalId, SecretString: value }));
    this.cache.delete(ref);
    const next = {
      ciphertext: null,
      rotatedAt: this.now().toISOString(),
      version: row.version + 1,
      expiresAt: expiresAt === undefined ? row.expiresAt : expiresAt ? expiresAt.toISOString() : null,
    };
    await this.rows.update(ref, next);
    return toMetadata({ ...row, ...next });
  }

  async resolve(ref: string): Promise<string> {
    const cached = this.cache.get(ref);
    if (cached && cached.expires > Date.now()) return cached.value;
    const row = await this.rows.get(ref);
    if (!row?.externalId) throw notFound('secret', ref);
    const out = await this.client.send(new GetSecretValueCommand({ SecretId: row.externalId }));
    if (out.SecretString === undefined) throw notFound('secret_value', ref);
    this.cache.set(ref, { value: out.SecretString, expires: Date.now() + (this.options.cacheTtlMs ?? 60_000) });
    return out.SecretString;
  }

  async describe(ref: string): Promise<SecretMetadata | null> {
    const row = await this.rows.get(ref);
    return row ? toMetadata(row) : null;
  }

  list(): Promise<SecretMetadata[]> {
    return this.rows.list();
  }

  async delete(ref: string): Promise<void> {
    const row = await this.rows.get(ref);
    if (row?.externalId) {
      await this.client.send(
        new DeleteSecretCommand({
          SecretId: row.externalId,
          RecoveryWindowInDays: this.options.recoveryWindowDays ?? 7,
        }),
      );
    }
    this.cache.delete(ref);
    await this.rows.delete(ref);
  }
}
