import { readFileSync } from 'node:fs';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SQSClient } from '@aws-sdk/client-sqs';
import { LocalBlobStore, S3BlobStore, type BlobDriverDefinition } from '@ocso/blob';
import { parseQueueUrls, type WorkerEnv } from '@ocso/config';
import { ComposeDeploymentAdapter, EcsDeploymentAdapter, type DeploymentDriverDefinition } from '@ocso/deployment';
import { PgQueue, SqsQueue, TOPICS, type QueueDriverDefinition } from '@ocso/queue';
import { AwsSecretStore, LocalSecretStore, parseMasterKey, type SecretStoreDriverDefinition } from '@ocso/secrets';
import type { DriverEnv } from '../plugin.js';

/**
 * First-party infrastructure drivers (docs/archive/specs/02 §6, build rule §17): how each
 * `*_DRIVER` value maps the environment onto an adapter. A driver's settings
 * checks live with it, so a new driver never edits a central switch.
 */

/** Filesystem blobs; signed links are served (and verified) by the API's /blobs route. */
export const localBlobDriver: BlobDriverDefinition<DriverEnv> = {
  name: 'local',
  check: (env) => (env.BLOB_SIGNING_KEY ? [] : ['BLOB_DRIVER=local requires BLOB_SIGNING_KEY']),
  create: (env) => new LocalBlobStore({ rootDir: env.BLOB_LOCAL_DIR, publicApiBaseUrl: env.OCSO_PUBLIC_URL, signingKey: env.BLOB_SIGNING_KEY! }),
};

/** S3 or an S3-compatible store (S3_ENDPOINT); presigned links. */
export const s3BlobDriver: BlobDriverDefinition<DriverEnv> = {
  name: 's3',
  check: (env) => (env.S3_BUCKET ? [] : ['BLOB_DRIVER=s3 requires S3_BUCKET']),
  create: (env) =>
    new S3BlobStore({ bucket: env.S3_BUCKET!, region: env.AWS_REGION ?? 'us-east-1', endpoint: env.S3_ENDPOINT, kmsKeyId: env.S3_KMS_KEY_ID }),
};

/** AES-256-GCM envelope encryption in PostgreSQL; master key inline or from OCSO_SECRETS_MASTER_KEY_FILE. */
export const localSecretsDriver: SecretStoreDriverDefinition<DriverEnv> = {
  name: 'local',
  check: (env) =>
    env.OCSO_SECRETS_MASTER_KEY || env.OCSO_SECRETS_MASTER_KEY_FILE ? [] : ['SECRETS_DRIVER=local requires OCSO_SECRETS_MASTER_KEY or OCSO_SECRETS_MASTER_KEY_FILE'],
  create: (env, { rows }) =>
    new LocalSecretStore(rows, parseMasterKey('k1', env.OCSO_SECRETS_MASTER_KEY ?? readFileSync(env.OCSO_SECRETS_MASTER_KEY_FILE!, 'utf8'))),
};

/** AWS Secrets Manager; PostgreSQL keeps metadata and the ARN. */
export const awsSecretsDriver: SecretStoreDriverDefinition<DriverEnv> = {
  name: 'aws',
  create: (env, { rows }) => new AwsSecretStore(new SecretsManagerClient(awsRegion(env)), rows, { namePrefix: env.SECRETS_NAME_PREFIX }),
};

/** PostgreSQL `jobs` table (SKIP LOCKED) with conversation affinity for turns. */
export const postgresQueueDriver: QueueDriverDefinition<DriverEnv> = {
  name: 'postgres',
  create: (_env, { sql, workerId, notifier }) => new PgQueue(sql, { workerId, conversationAffinityTopics: [TOPICS.CONVERSATION_TURN], notifier }),
};

/** SQS Standard, one queue per topic (SQS_QUEUE_URLS). */
export const sqsQueueDriver: QueueDriverDefinition<DriverEnv> = {
  name: 'sqs',
  check: (env) => {
    if (!env.SQS_QUEUE_URLS || !env.AWS_REGION) return ['QUEUE_DRIVER=sqs requires SQS_QUEUE_URLS and AWS_REGION'];
    try {
      parseQueueUrls(env.SQS_QUEUE_URLS);
      return [];
    } catch (error) {
      return [(error as Error).message];
    }
  },
  create: (env) => new SqsQueue(new SQSClient(awsRegion(env)), { queueUrls: parseQueueUrls(env.SQS_QUEUE_URLS) }),
};

/** Compose: replicas are operator-controlled, so scaling answers with advice. */
export const composeDeploymentDriver: DeploymentDriverDefinition<WorkerEnv> = {
  name: 'compose',
  create: () => new ComposeDeploymentAdapter(),
};

/** ECS Fargate: Application Auto Scaling + CloudWatch, scale-in protection per turn. */
export const ecsDeploymentDriver: DeploymentDriverDefinition<WorkerEnv> = {
  name: 'ecs',
  check: (env) => (env.ECS_CLUSTER && env.ECS_WORKER_SERVICE ? [] : ['DEPLOYMENT_DRIVER=ecs requires ECS_CLUSTER and ECS_WORKER_SERVICE']),
  create: (env, { logger }) =>
    new EcsDeploymentAdapter({
      cluster: env.ECS_CLUSTER ?? '',
      service: env.ECS_WORKER_SERVICE ?? '',
      metricsNamespace: env.OCSO_METRICS_NAMESPACE,
      region: env.AWS_REGION,
      agentUri: env.ECS_AGENT_URI,
      logger,
    }),
};

/** Region config without passing `undefined` (exactOptionalPropertyTypes). */
function awsRegion(env: DriverEnv): { region?: string } {
  return env.AWS_REGION ? { region: env.AWS_REGION } : {};
}
