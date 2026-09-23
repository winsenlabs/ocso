# Infrastructure drivers: blob storage, secrets, queue, deployment, audit store

These five contracts let the same application run on a single Docker host and on AWS without two code
paths (build rule [§17](../99-BUILD-RULES.md#17-same-application-two-deployment-shapes)). Each is a
small registry of named drivers, filled from the plugins (like channels, model providers and alert
destinations) and selected by one environment variable at start-up. Product code depends only on the
contract and never branches on the driver. [Email senders](email.md) work the same way.

| Contract | Driver definition | First-party drivers | Chosen by | Default |
|---|---|---|---|---|
| `BlobStore` (`packages/blob/src/contract.ts`) | `BlobDriverDefinition` | `local` (a volume), `s3` (AWS S3 or an S3-compatible store such as SeaweedFS) | `BLOB_DRIVER` | `local` |
| `SecretStore` (`packages/secrets/src/contract.ts`) | `SecretStoreDriverDefinition` | `local` (AES-256-GCM envelope encryption in PostgreSQL, master key from a file), `aws` (Secrets Manager) | `SECRETS_DRIVER` | `local` |
| `QueueAdapter` (`packages/queue/src/contract.ts`) | `QueueDriverDefinition` | `postgres` (`jobs` table, `SKIP LOCKED`), `sqs` (Standard queues with DLQs); `memory` for tests | `QUEUE_DRIVER` | `postgres` |
| `DeploymentAdapter` (`packages/deployment/src/contract.ts`) | `DeploymentDriverDefinition` | `compose` (advisory), `ecs` (Application Auto Scaling, CloudWatch, task protection) | `DEPLOYMENT_DRIVER` (worker) | `compose` |
| `AuditStore` (`packages/audit-store/src/contract.ts`, ADR-032) | `AuditStoreDriverDefinition` | `postgres` (its own database, monthly partitions, INSERT/SELECT writer role), `clickhouse` (HTTP interface, MergeTree read first-copy-wins) | `AUDIT_DRIVER` | `postgres` |

## How selection works

- **Env.** `packages/config/src/env.ts` parses each `*_DRIVER` as an open string (trimmed, 1–64
  characters) with the defaults above. It no longer lists driver names.
- **Registries.** The composition root (`packages/bootstrap`) fills one `DriverRegistry` per contract
  from every plugin's `blobDrivers`, `secretsDrivers`, `queueDrivers`, `deploymentDrivers` and `auditStoreDrivers`
  (`createDriverRegistries(plugins)`). Same shape as the other registries: `register`, `get`, `has`,
  `list`. Names are lower case `a-z0-9-`; a duplicate name refuses to start.
- **Start-up check.** The api and worker call `assertDrivers(env, drivers)` (the worker
  `assertWorkerDrivers`, which adds `DEPLOYMENT_DRIVER`) right after parsing the environment; both
  include `AUDIT_DRIVER` (and, in production, the audit signing key). It
  throws one `Invalid OCSO configuration` error listing every problem: an unregistered name, with the
  registered alternatives, and each selected driver's own settings checks.

```text
Invalid OCSO configuration:
  - BLOB_DRIVER=gcs is not available; registered blob drivers: local, s3
  - QUEUE_DRIVER=sqs requires SQS_QUEUE_URLS and AWS_REGION
```

- **Construction.** `createBlobStore`, `createSecretStore`, `createQueue`, `createDeploymentAdapter`
  and `createAuditStore` (all in `@ocso/bootstrap`) ask the registry for the selected driver and call
  its `create`. The first-party definitions are in `packages/bootstrap/src/drivers/first-party.ts`
  (the audit store's in `packages/audit-store/src/drivers.ts`, contributed by the `@ocso/audit-store`
  plugin entry); each carries its own `check`, so a new driver never edits a central switch.

## The driver contract

Every driver kind has the same three members. `Env` is the parsed environment the driver reads; the
first-party drivers use `ApiEnv | WorkerEnv` from `@ocso/config`.

```ts
export interface BlobDriverDefinition<Env> {
  /** BLOB_DRIVER value that selects this driver, e.g. `s3`. */
  readonly name: string;
  /** Missing or inconsistent settings; start-up fails naming every one. */
  readonly check?: (env: Env) => readonly string[];
  readonly create: (env: Env) => BlobStore;
}

// SecretStoreDriverDefinition: create(env, { rows })            — rows = the `secrets` metadata table
// QueueDriverDefinition:       create(env, { sql, workerId, notifier? })
// DeploymentDriverDefinition:  create(env, { logger? })          — worker only
// AuditStoreDriverDefinition:  create(env, { logger, fetch? })    — plus provision(env, { log }) for audit-migrate
```

A driver ships in a plugin (see [README.md](README.md#the-plugin-shape)):

```ts
export const gcsBlobs: BlobDriverDefinition<DriverEnv> = {
  name: 'gcs',
  check: (env) => (process.env['GCS_BUCKET'] ? [] : ['BLOB_DRIVER=gcs requires GCS_BUCKET']),
  create: () => new GcsBlobStore({ bucket: process.env['GCS_BUCKET']! }),
};
const plugin: OcsoPlugin = { name: '@acme/ocso-gcs', blobDrivers: [gcsBlobs] };
```

The parsed env only carries the settings `@ocso/config` declares, so a driver with settings of its
own reads them from `process.env` today; letting a driver declare its env schema is part of the SDK
roadmap.

## Contracts, trimmed

```ts
export interface BlobStore {
  readonly driver: string; // the driver's name; display and logs only
  put(input: BlobPutInput): Promise<BlobObject>;
  get(key: string): Promise<{ data: Uint8Array; contentType: string; sizeBytes: number }>;
  head(key: string): Promise<{ contentType: string; sizeBytes: number } | null>;
  delete(key: string): Promise<void>;
  /** Short-lived HTTPS URL for downloads (browser, channel providers). */
  signedGetUrl(key: string, ttlSeconds: number): Promise<string>;
  /** Stores whose signed URLs point at OCSO's /blobs route verify them here; others omit it. */
  verifySignedGet?(key: string, exp: number, sig: string, nowSeconds: number): boolean;
}

export interface SecretStore {
  readonly driver: string;
  put(input: PutSecretInput): Promise<SecretMetadata>;
  rotate(ref: string, value: string, expiresAt?: Date | null): Promise<SecretMetadata>;
  /** Resolve the plaintext value. Trusted server-side code only. */
  resolve(ref: string): Promise<string>;
  describe(ref: string): Promise<SecretMetadata | null>;
  list(): Promise<SecretMetadata[]>;
  delete(ref: string): Promise<void>;
}

export interface QueueAdapter {
  readonly driver: string;
  /** Messages live in OCSO's PostgreSQL `jobs` table, so SQL may read the queue directly. */
  readonly inDatabase: boolean;
  /** False when stats() cannot tell the oldest message's age (SQS: a CloudWatch metric). */
  readonly reportsOldestAge: boolean;
  publish<T>(topic: Topic, payload: T, options?: PublishOptions): Promise<void>;
  consume<T>(topic: Topic, handler: MessageHandler<T>, options: ConsumeOptions): QueueSubscription;
  stats(topic: Topic): Promise<QueueStats>;
}

export interface DeploymentAdapter {
  readonly driver: string;
  readonly publishesMetrics: boolean;
  /** Includes `facts`: the worker deployment panel rows, in the driver's own words. */
  describe(): Promise<DeploymentStatus>;
  /** Idempotent: calling it again with the same settings changes nothing. */
  applyScaling(input: ScalingSettings): Promise<ScalingApplyResult>;
  publishMetrics(sample: ScalingSample): Promise<void>;
  taskProtection(): TaskProtection;
}
```

Where the core needs to know something about a driver, it asks the adapter for a capability instead
of comparing names: the `/blobs` route calls `verifySignedGet` (absent on S3, so the route refuses),
the alert queue-age condition reads the `jobs` table only when `inDatabase`, the scaling sample falls
back to PostgreSQL for the queue age when `reportsOldestAge` is false, and the System → Workers panel
renders the deployment status from its `facts`.

## The audit store driver (ADR-032)

The audit store is the system of record for audit events; the main database's `audit_events` is its
transactional outbox. A driver implements this contract (trimmed):

```ts
export interface AuditStore {
  readonly driver: string;
  append(records: readonly AuditRecord[]): Promise<void>;           // idempotent on id
  has(ids: readonly string[]): Promise<ReadonlySet<string>>;         // reconciliation
  query(q: AuditStoreQuery, scope: AuditScopeFilter): Promise<AuditRecord[]>; // (occurredAt, id) DESC, keyset
  unsealed(limit: number): Promise<AuditRecord[]>;                   // arrival order
  chainHead(): Promise<ChainEntry | null>;
  appendChain(entries: readonly ChainEntry[]): Promise<void>;        // refuses a gap or a fork
  appendCheckpoint(c: Checkpoint): Promise<void>;
  checkpoints(q: CheckpointQuery): Promise<Checkpoint[]>;
  chainRange(fromPosition: number, limit: number): Promise<ChainRangeItem[]>; // + forks / conflicts it can see
  purgeBefore(cutoff: Date): Promise<number>;                        // store minimum retention; logged
  purgeHorizon(): Promise<Date | null>;                              // newest logged purge cutoff
  stats(): Promise<AuditStoreStats>;
  health(): Promise<AuditStoreHealth>;                               // answers within ~5 s, never hangs
  selfCheck(): Promise<AuditStoreSelfCheck>;                         // canWrite + weaknesses to show
  close(): Promise<void>;
}
```

What a driver must guarantee: the writer credentials the worker holds cannot update or delete
records, chain entries or checkpoints (postgres: grants plus triggers; clickhouse: grants — the
purge runs as a separate worker-only user because dropping a partition needs `ALTER DELETE`), and
the reader credentials the api holds can only SELECT; every call is time-bounded
(`AUDIT_STORE_TIMEOUT_MS`), so a store that stops answering fails instead of hanging the leader;
`purgeBefore` honours a minimum retention the writer cannot change and logs every removal, so
verification (`purgeHorizon`) can tell retention from deletion; `chainRange` reports what an INSERT
alone could do to history in that store (`forks`: another chain row at a position or sealing the
same record; `conflicts`: another stored copy of a record with different content); reads return the
first stored copy of a record; `append` is idempotent; `query` applies the `AuditScopeFilter` (actor, team ids, shared target
types) itself, since the store cannot join the main database; ties on time sort by the id as a
string; times keep millisecond precision (hashes are computed over what the store returns). Hashing,
signing and verification are shared code (`canonical.ts`, `signing.ts`, `chain.ts`), not the
driver's. `provision` (the `audit-migrate` bin, owner credentials) applies the driver's schema from
`packages/audit-store/migrations/<driver>`, sets the minimum retention and ensures the writer and
(optional) reader roles; in production it refuses a writer that is the owner/admin unless
`AUDIT_ALLOW_OWNER_WRITER=true`.

Tests to copy: `packages/audit-store/test/postgres-store.int.test.ts` and
`clickhouse-store.int.test.ts` (the same cases; the ClickHouse one runs when `CLICKHOUSE_TEST_URL`
points at a server), `packages/bootstrap/test/audit-drivers.test.ts` (selection).

## What the core relies on

- **Blob.** PostgreSQL keeps media metadata and keys; the store keeps bytes. Keys are generated by OCSO
  (`mediaKey`, `assertSafeKey`). Browsers and channel providers only get short-lived signed URLs.
- **Secrets.** Every other table stores a reference such as `sec_bdrk_4f81a2`, never a value. Values are
  resolved server-side by trusted code, just before use, and never returned to a browser, a prompt, a log
  or an audit payload (ADR-012).
- **Queue.** Messages are wake-ups; the work is in PostgreSQL. Correctness comes from conversation
  leases with fencing, not from queue ordering or single delivery. A duplicate or lost message is
  harmless: the lease-recovery sweep re-enqueues stranded turns (ADR-008).
- **Audit store.** Readiness never depends on it: events wait in the outbox while it is down, the
  audit screen merges rows not yet confirmed in the store (and serves the local window, with a
  banner, when the store fails or does not answer within 5 s), and incidents record the outage. The
  sealer is fenced by a lock in the main database, so a driver without unique positions is never
  written by two sealers at once. Reads are always scoped by the caller's `AuditScopeFilter`.
- **Deployment.** The worker's scheduler leader reconciles the Tech Admin's worker settings through the
  adapter. Compose returns advice and the exact `docker compose up -d --scale worker=N` command; ECS
  applies the settings ([docs/operations/worker-scaling.md](../operations/worker-scaling.md)).

## Tests to copy

`packages/bootstrap/test/drivers.test.ts` (selection, the start-up check, a driver from another
plugin), `packages/blob/test/blob.test.ts`, `packages/secrets/test/local-store.test.ts`,
`packages/queue/test/pg-queue.int.test.ts` (PostgreSQL), and `packages/deployment/test/` (fake AWS
clients in `fake-aws.ts`).

## Limits today

- Driver-specific settings are declared in `packages/config/src/env.ts` (the parsed env strips
  unknown keys), so a third-party driver reads its own settings from `process.env`.
- Test coverage is uneven. The `ecs` deployment adapter has unit tests with fake AWS clients. The `s3`,
  `aws` (Secrets Manager) and `sqs` drivers have no automated tests against the real services; the `s3`
  driver can be run locally against SeaweedFS with the Compose `s3` profile. No deployment has been
  applied to a real AWS account; see the known gaps in
  [docs/operations/aws.md](../operations/aws.md#10-known-gaps-and-follow-ups).
- Switching blob drivers does not migrate existing blobs.
- Deployment snapshots recorded before `facts` existed show only their note until the next describe.
