import { readFileSync } from 'node:fs';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SQSClient } from '@aws-sdk/client-sqs';
import { LocalBlobStore, S3BlobStore, type BlobStore } from '@ocso/blob';
import { parseQueueUrls, type ApiEnv, type WorkerEnv } from '@ocso/config';
import { secrets as secretsTable, type Db } from '@ocso/db';
import { PgQueue, SqsQueue, type QueueAdapter, type SqlClient } from '@ocso/queue';
import {
  AwsSecretStore,
  LocalSecretStore,
  parseMasterKey,
  type SecretMetadata,
  type SecretRow,
  type SecretRowStore,
  type SecretStore,
} from '@ocso/secrets';
import { eq } from 'drizzle-orm';

type Env = ApiEnv | WorkerEnv;

/**
 * Adapter selection by configuration (docs/02 §6, build rule §17). This is the
 * only place that knows which infrastructure the deployment uses.
 */
export function createSecretStore(env: Env, db: Db): SecretStore {
  const rows = new DrizzleSecretRows(db);
  if (env.SECRETS_DRIVER === 'aws') {
    return new AwsSecretStore(new SecretsManagerClient(awsRegion(env)), rows, { namePrefix: env.SECRETS_NAME_PREFIX });
  }
  const raw = env.OCSO_SECRETS_MASTER_KEY ?? readFileSync(env.OCSO_SECRETS_MASTER_KEY_FILE!, 'utf8');
  return new LocalSecretStore(rows, parseMasterKey('k1', raw));
}

export function createBlobStore(env: Env): BlobStore {
  if (env.BLOB_DRIVER === 's3') {
    return new S3BlobStore({
      bucket: env.S3_BUCKET!,
      region: env.AWS_REGION ?? 'us-east-1',
      endpoint: env.S3_ENDPOINT,
      kmsKeyId: env.S3_KMS_KEY_ID,
    });
  }
  return new LocalBlobStore({
    rootDir: env.BLOB_LOCAL_DIR,
    publicApiBaseUrl: env.OCSO_PUBLIC_URL,
    signingKey: env.BLOB_SIGNING_KEY!,
  });
}

export function createQueue(env: Env, sql: SqlClient, workerId: string): QueueAdapter {
  if (env.QUEUE_DRIVER === 'sqs') {
    return new SqsQueue(new SQSClient(awsRegion(env)), { queueUrls: parseQueueUrls(env.SQS_QUEUE_URLS) });
  }
  return new PgQueue(sql, { workerId, conversationAffinityTopics: ['conversation.turn'] });
}

/** SecretRowStore over the `secrets` table. */
class DrizzleSecretRows implements SecretRowStore {
  constructor(private readonly db: Db) {}

  async insert(row: SecretRow): Promise<void> {
    await this.db.insert(secretsTable).values(toDb(row));
  }

  async update(ref: string, patch: Pick<SecretRow, 'ciphertext' | 'rotatedAt' | 'version' | 'expiresAt'>): Promise<void> {
    await this.db
      .update(secretsTable)
      .set({
        ciphertext: patch.ciphertext,
        rotatedAt: patch.rotatedAt ? new Date(patch.rotatedAt) : null,
        version: patch.version,
        expiresAt: patch.expiresAt ? new Date(patch.expiresAt) : null,
      })
      .where(eq(secretsTable.ref, ref));
  }

  async get(ref: string): Promise<SecretRow | null> {
    const [row] = await this.db.select().from(secretsTable).where(eq(secretsTable.ref, ref));
    return row ? fromDb(row) : null;
  }

  async list(): Promise<SecretMetadata[]> {
    const rows = await this.db.select().from(secretsTable);
    return rows.map((r) => {
      const { ciphertext: _c, externalId: _e, ...meta } = fromDb(r);
      return meta;
    });
  }

  async delete(ref: string): Promise<void> {
    await this.db.delete(secretsTable).where(eq(secretsTable.ref, ref));
  }
}

function toDb(row: SecretRow): typeof secretsTable.$inferInsert {
  return {
    ref: row.ref,
    name: row.name,
    kind: row.kind,
    usedBy: row.usedBy,
    ciphertext: row.ciphertext,
    externalId: row.externalId,
    version: row.version,
    createdAt: new Date(row.createdAt),
    rotatedAt: row.rotatedAt ? new Date(row.rotatedAt) : null,
    expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
  };
}

function fromDb(r: typeof secretsTable.$inferSelect): SecretRow {
  return {
    ref: r.ref,
    name: r.name,
    kind: r.kind as SecretRow['kind'],
    usedBy: r.usedBy,
    ciphertext: r.ciphertext,
    externalId: r.externalId,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    rotatedAt: r.rotatedAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
  };
}

/** Region config without passing `undefined` (exactOptionalPropertyTypes). */
function awsRegion(env: Env): { region?: string } {
  return env.AWS_REGION ? { region: env.AWS_REGION } : {};
}
