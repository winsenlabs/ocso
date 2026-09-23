import { randomBytes } from 'node:crypto';
import { LocalBlobStore, S3BlobStore, type BlobDriverDefinition, type BlobStore } from '@ocso/blob';
import { ApiEnv, WorkerEnv, loadEnv } from '@ocso/config';
import { ComposeDeploymentAdapter, EcsDeploymentAdapter } from '@ocso/deployment';
import { ResendEmailSender, createEmailSender, emailStatus, resolveEmailConfig } from '@ocso/email';
import { PgQueue, SqsQueue, type SqlClient } from '@ocso/queue';
import { InMemorySecretRows, LocalSecretStore } from '@ocso/secrets';
import { describe, expect, it } from 'vitest';
import {
  DriverRegistry,
  FIRST_PARTY_PLUGINS,
  assertDrivers,
  assertWorkerDrivers,
  createBlobStore,
  createDeploymentAdapter,
  createDriverRegistries,
  createQueue,
  localSecretsDriver,
  selectDriver,
  type DriverEnv,
  type OcsoPlugin,
} from '../src/index.js';

const MASTER_KEY = randomBytes(32).toString('base64');
const base = { DATABASE_URL: 'postgres://u:pw@db:5432/ocso', BLOB_SIGNING_KEY: 'x'.repeat(32), OCSO_SECRETS_MASTER_KEY: MASTER_KEY, AUDIT_DATABASE_URL: 'postgres://w:pw@audit-db:5432/ocso_audit' };
const sql: SqlClient = { query: async () => ({ rows: [], rowCount: 0 }) };

describe('driver registries (composition root)', () => {
  it('registers every first-party driver under its existing *_DRIVER value', () => {
    const drivers = createDriverRegistries();
    expect(drivers.email.names()).toEqual(['resend', 'smtp', 'log']);
    expect(drivers.blob.names()).toEqual(['local', 's3']);
    expect(drivers.secrets.names()).toEqual(['local', 'aws']);
    expect(drivers.queue.names()).toEqual(['postgres', 'sqs']);
    expect(drivers.deployment.names()).toEqual(['compose', 'ecs']);
    expect(drivers.audit.names()).toEqual(['postgres', 'clickhouse']);
  });

  it('keeps the live Compose configuration working: resend via RESEND_API_KEY_FILE, local blobs and secrets, postgres queue, compose', () => {
    const env = loadEnv(WorkerEnv, {
      ...base,
      NODE_ENV: 'production',
      EMAIL_DRIVER: 'resend',
      EMAIL_FROM: 'OCSO <ocso@mail.meridian.test>',
      RESEND_API_KEY: '',
      RESEND_API_KEY_FILE: '/run/secrets/ocso/resend_api_key',
      BLOB_DRIVER: 'local',
      // Compose hands the audit store's writer URL and signing key over as files (ADR-032).
      AUDIT_DATABASE_URL: '',
      AUDIT_DATABASE_URL_FILE: '/run/secrets/ocso/audit_database_url',
      AUDIT_SIGNING_KEY_FILE: '/run/secrets/ocso/audit_signing_key',
    });
    const drivers = createDriverRegistries();
    expect(() => assertWorkerDrivers(env, drivers)).not.toThrow();

    const email = resolveEmailConfig(env, { drivers: drivers.email.list(), readFile: () => 're_live_key\n' });
    expect(emailStatus(email)).toMatchObject({ driver: 'resend', label: 'Resend', configured: true });
    expect(createEmailSender(env, { drivers: drivers.email.list(), readFile: () => 're_live_key' })).toBeInstanceOf(ResendEmailSender);
    expect(createBlobStore(env, drivers)).toBeInstanceOf(LocalBlobStore);
    expect(localSecretsDriver.create(env, { rows: new InMemorySecretRows() })).toBeInstanceOf(LocalSecretStore);
    expect(createQueue(env, sql, 'w1', undefined, drivers)).toBeInstanceOf(PgQueue);
    expect(createDeploymentAdapter(env, undefined, drivers)).toBeInstanceOf(ComposeDeploymentAdapter);
  });

  it('selects the AWS drivers by name once their settings are complete', () => {
    const env = loadEnv(WorkerEnv, {
      ...base,
      AWS_REGION: 'eu-west-1',
      BLOB_DRIVER: 's3',
      S3_BUCKET: 'ocso-media',
      QUEUE_DRIVER: 'sqs',
      SQS_QUEUE_URLS: 'conversation.turn=https://sqs.eu-west-1.amazonaws.com/1/turn',
      DEPLOYMENT_DRIVER: 'ecs',
      ECS_CLUSTER: 'ocso-prod',
      ECS_WORKER_SERVICE: 'ocso-worker',
    });
    const drivers = createDriverRegistries();
    expect(() => assertWorkerDrivers(env, drivers)).not.toThrow();
    expect(createBlobStore(env, drivers)).toBeInstanceOf(S3BlobStore);
    expect(createQueue(env, sql, 'w1', undefined, drivers)).toBeInstanceOf(SqsQueue);
    expect(createDeploymentAdapter(env, undefined, drivers)).toBeInstanceOf(EcsDeploymentAdapter);
  });

  it("runs each selected driver's own settings checks and lists every problem", () => {
    const drivers = createDriverRegistries();
    const env = loadEnv(WorkerEnv, { DATABASE_URL: base.DATABASE_URL, QUEUE_DRIVER: 'sqs', BLOB_DRIVER: 's3', DEPLOYMENT_DRIVER: 'ecs' });
    let message = '';
    try {
      assertWorkerDrivers(env, drivers);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message.split('\n')).toEqual([
      'Invalid OCSO configuration:',
      '  - BLOB_DRIVER=s3 requires S3_BUCKET',
      '  - SECRETS_DRIVER=local requires OCSO_SECRETS_MASTER_KEY or OCSO_SECRETS_MASTER_KEY_FILE',
      '  - QUEUE_DRIVER=sqs requires SQS_QUEUE_URLS and AWS_REGION',
      '  - DEPLOYMENT_DRIVER=ecs requires ECS_CLUSTER and ECS_WORKER_SERVICE',
      '  - AUDIT_DRIVER=postgres requires AUDIT_DATABASE_URL (or AUDIT_DATABASE_URL_FILE)',
    ]);
    // The API does not select a deployment driver.
    expect(() => assertDrivers(loadEnv(ApiEnv, { ...base, DEPLOYMENT_DRIVER: 'ecs' }), drivers)).not.toThrow();
    expect(() => assertDrivers(loadEnv(ApiEnv, { ...base, BLOB_DRIVER: 'local', BLOB_SIGNING_KEY: undefined }), drivers)).toThrow(/BLOB_DRIVER=local requires BLOB_SIGNING_KEY/);
    expect(() => assertDrivers(loadEnv(ApiEnv, { ...base, QUEUE_DRIVER: 'sqs', AWS_REGION: 'eu-west-1', SQS_QUEUE_URLS: 'no-pairs' }), drivers)).toThrow(/topic=url pairs/);
  });

  it('refuses an unregistered driver name with the registered alternatives', () => {
    const drivers = createDriverRegistries();
    const env = loadEnv(ApiEnv, { ...base, BLOB_DRIVER: 'gcs', QUEUE_DRIVER: 'rabbitmq' });
    expect(() => assertDrivers(env, drivers)).toThrow(
      /BLOB_DRIVER=gcs is not available; registered blob drivers: local, s3\n {2}- QUEUE_DRIVER=rabbitmq is not available; registered queue drivers: postgres, sqs/,
    );
    expect(() => createBlobStore(env, drivers)).toThrow(/registered blob drivers: local, s3/);
    expect(() => resolveEmailConfig({ EMAIL_DRIVER: 'sendgrid' }, { drivers: drivers.email.list() })).toThrow(/registered email drivers: resend, smtp, log/);
  });

  it('selects a driver contributed by another plugin exactly like a first-party one', () => {
    const stores: string[] = [];
    const memoryBlobs: BlobDriverDefinition<DriverEnv> = {
      name: 'memory',
      check: (env) => (env.BLOB_LOCAL_DIR ? [] : ['BLOB_DRIVER=memory needs BLOB_LOCAL_DIR']),
      create: (env) => {
        stores.push(env.BLOB_LOCAL_DIR);
        return { driver: 'memory' } as unknown as BlobStore;
      },
    };
    const plugins: OcsoPlugin[] = [...FIRST_PARTY_PLUGINS, { name: 'acme-blobs', blobDrivers: [memoryBlobs] }];
    const drivers = createDriverRegistries(plugins);
    expect(drivers.blob.names()).toEqual(['local', 's3', 'memory']);
    const env = loadEnv(ApiEnv, { ...base, BLOB_DRIVER: 'memory' });
    expect(createBlobStore(env, drivers).driver).toBe('memory');
    expect(stores).toEqual(['./data/blobs']);
    // Only registered drivers exist: without the plugin the name is refused.
    expect(() => createBlobStore(env)).toThrow(/BLOB_DRIVER=memory is not available/);
  });

  it('refuses duplicate or malformed driver names and duplicate plugins', () => {
    expect(() => createDriverRegistries([...FIRST_PARTY_PLUGINS, { name: 'again', blobDrivers: [{ name: 's3', create: () => ({}) as BlobStore }] }])).toThrow(
      /blob driver s3 is already registered/,
    );
    expect(() => new DriverRegistry<{ name: string }>('BLOB_DRIVER', 'blob').register({ name: 'S3 Bucket' })).toThrow(/must be lower case/);
    expect(() => createDriverRegistries([...FIRST_PARTY_PLUGINS, { name: '@ocso/blob' }])).toThrow(/@ocso\/blob is listed twice/);
    const registry = new DriverRegistry<{ name: string; check?: () => string[] }>('QUEUE_DRIVER', 'queue');
    expect(() => selectDriver(registry, 'postgres', {})).toThrow('Invalid OCSO configuration:\n  - QUEUE_DRIVER=postgres is not available; registered queue drivers: none');
  });
});
