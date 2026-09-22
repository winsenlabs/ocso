# 05: AWS deployment, queues, autoscaling, blobs, secrets, IaC, Compose, OTel

Researched 2026-09-22. **Method:** I installed `@aws-sdk/{client-sqs,client-s3,s3-request-presigner,client-secrets-manager,client-cloudwatch,client-ecs,client-application-auto-scaling,credential-providers}@3.1137.0` in `/private/tmp/claude-501/research-aws` and read the `.d.ts` files. I type-checked every SDK snippet below with `tsc --strict` (`check.ts`) and generated presigned URLs locally (`presign*.mjs`). I ran `terraform validate` in `hashicorp/terraform:1.16.3` against the TF below (`tf/main.tf`) and `docker compose config` against the Compose file (`compose/compose.yaml`). I also ran the Postgres queue SQL on `postgres:18` (18.6). Version numbers come from the npm, Terraform registry, Docker Hub and GitHub APIs today.

Tags: **VERIFIED(run)** means I executed it. **VERIFIED(types)** means I read it in the SDK `.d.ts`. **VERIFIED(docs)** means it comes from AWS or vendor docs fetched today. **UNVERIFIED** means inference or memory.

## TL;DR

- **Queue:** use an **SQS Standard** queue (not FIFO) plus a DLQ.
  - Messages are *pointers* (`{conversationId, eventId}`).
  - Ordering and single-writer come from the **Postgres conversation lease and event sequence**, not from the queue.
  - Set `MessageGroupId = conversationId` so fair queues apply.
  - Compose uses a Postgres `SKIP LOCKED` adapter behind the same `JobQueue` port.
  - Honest note: in AWS, the Postgres adapter would also work for v1. SQS mainly buys managed backlog metrics and decoupling.
- **Autoscaling:** one Application Auto Scaling scalable target on the worker service, with three layers:
  - **Target tracking** on a metric-math "slot demand per worker" metric. The app publishes it via EMF or PutMetricData.
  - **Step scaling** on queue age, for bursts and scale-from-zero.
  - **Task scale-in protection** only while a turn is in flight.
  - Tech Admin settings map 1:1 onto `RegisterScalableTarget`, `PutScalingPolicy` and `PutMetricAlarm`, and the app can call these at runtime.
- **Blobs:** in AWS, use S3 with SSE-KMS as the bucket default (Bucket Key on) and presigned URLs.
  - **Gotcha, VERIFIED(run):** SDK ≥3.729 signs a CRC32 of an *empty body* into presigned PUT URLs. The presigning client must set `requestChecksumCalculation: "WHEN_REQUIRED"`.
  - In Compose, the default is a **local-filesystem blob store**. An optional S3-compatible profile uses SeaweedFS.
  - **MinIO is dead as a community image:** Docker Hub `minio/minio` returns 404 and the GitHub repo is archived.
- **Secrets:**
  - AWS: Secrets Manager. The app writes provider keys with `CreateSecret`/`PutSecretValue` under an IAM-scoped name prefix, and the DB stores only the ARN.
  - Compose: an AES-256-GCM envelope store in Postgres, with the master key from a Docker secret file.
- **IaC:** **Terraform** (1.16.3, AWS provider 6.66.0), not CDK. Validate with Docker, no local install needed (VERIFIED(run)).
- **Postgres:**
  - Compose: `postgres:18` (18.6). **The PG18 image moved its volume to `/var/lib/postgresql`.**
  - AWS: RDS supports 18 (18.6 as of 2026-08).
- **OTel:**
  - Traces go direct to the CloudWatch/X-Ray OTLP endpoint via the ADOT Node distro (no sidecar).
  - Logs go to stdout via `awslogs`.
  - Scaling metrics go through **EMF or PutMetricData (classic metrics)**, *not* OTLP metrics.

## 1. SQS

**Facts:**

| Item | Value | Tag |
|---|---|---|
| `DelaySeconds` (queue or message) | 0–900 s | VERIFIED(types) |
| Per-message `DelaySeconds` on FIFO | **not allowed** ("you can set this parameter only on a queue level") | VERIFIED(types) |
| Visibility timeout | 0–43,200 s (default 30). The 12 h cap counts **from first receive**, and extending does not reset it. | VERIFIED(types+docs) |
| Long poll `WaitTimeSeconds` | max 20. `MaxNumberOfMessages` is 1–10. The HTTP timeout must be longer than the wait. | VERIFIED(types) |
| Receive attributes | `MessageSystemAttributeNames: ["ApproximateReceiveCount", …]`. `AttributeNames` is **deprecated**. | VERIFIED(types) |
| Max message size | 1 MiB (1,048,576 B). The default is also 1 MiB. | VERIFIED(types+docs) |
| Retention | 60 s–14 d, default 4 d | VERIFIED(docs) |
| In-flight | Standard ≈120k. FIFO 120k. | VERIFIED(docs) |
| FIFO throughput | 300 TPS per partition per action, or 3,000 msg/s with batching. High-throughput mode (`DeduplicationScope=messageGroup` + `FifoThroughputLimit=perMessageGroupId`) goes up to 70k TPS in us-east-1/us-west-2/eu-west-1 and 9k in ap-south-1, among others. | VERIFIED(docs+types) |
| FIFO dedup window | 5 minutes, using `MessageDeduplicationId` or `ContentBasedDeduplication` (SHA-256 of the body) | VERIFIED(docs) |
| `MessageGroupId` on **Standard** | Enables **fair queues** (noisy-neighbour isolation) with **no ordering**. Max 128 chars. | VERIFIED(types+docs) |
| DLQ | `RedrivePolicy={deadLetterTargetArn,maxReceiveCount}` and `RedriveAllowPolicy` (byQueue, up to 10 sources). DLQ retention should be longer than the source's, because on Standard the enqueue timestamp is kept. | VERIFIED(docs) |
| `ApproximateAgeOfOldestMessage` | Standard queues move a message that has been received 3 or more times without deletion to the back, so poison pills are **excluded** from the age metric. It only emits while the queue has messages. Dimension: `QueueName`. | VERIFIED(docs) |

**Why Standard, not FIFO, for OCSO:**

1. The Postgres conversation lease (version + expiry + heartbeat) is already the single-writer authority per conversation. FIFO would serialize a second time.
2. FIFO bans per-message delay, and we need delayed jobs such as retries, follow-ups and SLA timers.
3. A failed FIFO message **blocks its group** until it is deleted or expires, and AWS says not to use a DLQ with FIFO if exact order matters.
4. The 12 h visibility cap means a queue message cannot represent a long-lived conversation lease anyway.

Design: each message is `{conversationId, eventId}`. The worker then:

1. Receives the message.
2. `tryAcquireLease(conversationId)` in Postgres.
3. If another worker holds the lease: `DeleteMessage`. The holder drains pending events from the DB inbox by sequence.
4. Otherwise: process events in `seq` order, commit, then `DeleteMessage`.

Duplicates, which are at-least-once, are absorbed by a unique `(conversation_id, event_id)` processed-marker. If FIFO is ever needed: `MessageGroupId=conversationId`, `MessageDeduplicationId=eventId`, high-throughput mode.

Consumer loop and heartbeat (VERIFIED(types): compiles against 3.1137):

```ts
const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 20,
  VisibilityTimeout: 120, MessageSystemAttributeNames: ["ApproximateReceiveCount", "SentTimestamp"] }));
// heartbeat every ~40s while the turn runs (cap: 12h from first receive)
await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl, ReceiptHandle, VisibilityTimeout: 120 }));
// retry with backoff = make it visible later instead of deleting (counts toward maxReceiveCount → DLQ)
await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl, ReceiptHandle, VisibilityTimeout: backoffSec }));
await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody, MessageGroupId: conversationId, DelaySeconds: 30 }));
```

**Delays over 900 s** (both modes): keep a Postgres `scheduled_jobs` table with a relay loop that enqueues due rows. That keeps the code identical across modes and avoids adding EventBridge Scheduler.

**Queue port:** `enqueue({queue, payload, groupKey?, dedupKey?, delaySec?})`, `receive(queue, {max, waitSec, visibilitySec})`, `extend(handle, sec)`, `ack(handle)`, `nack(handle, {retryInSec})`, `deadLetters(queue)`. Documented capability gaps:

- SQS Standard has no enqueue dedup (it is done in the DB).
- Delay is limited to 900 s (use the relay).

**Postgres adapter** (VERIFIED(run) on PG 18.6). It covers claims, per-group head-of-line ordering, dedup, heartbeat, backoff and dead-lettering:

```sql
CREATE TABLE job_queue (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, queue text NOT NULL, group_key text,
  dedup_key text, payload jsonb NOT NULL, run_at timestamptz NOT NULL DEFAULT now(), attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5, locked_by text, locked_until timestamptz, last_error text, dead_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX ON job_queue (queue, dedup_key) WHERE dedup_key IS NOT NULL AND dead_at IS NULL;  -- enqueue: ON CONFLICT DO NOTHING
CREATE INDEX ON job_queue (queue, run_at) WHERE dead_at IS NULL;
-- claim (visibility = locked_until; delay = run_at; only the head of each group is eligible)
WITH c AS (SELECT j.id FROM job_queue j WHERE j.queue=$1 AND j.dead_at IS NULL AND j.run_at<=now()
    AND (j.locked_until IS NULL OR j.locked_until<now())
    AND NOT EXISTS (SELECT 1 FROM job_queue p WHERE p.queue=j.queue AND p.group_key=j.group_key AND p.id<j.id AND p.dead_at IS NULL)
  ORDER BY j.run_at, j.id LIMIT $2 FOR UPDATE SKIP LOCKED)
UPDATE job_queue j SET locked_by=$3, locked_until=now()+make_interval(secs=>$4), attempts=attempts+1
FROM c WHERE j.id=c.id RETURNING j.*;
-- heartbeat: UPDATE ... SET locked_until=now()+… WHERE id=$1 AND locked_by=$2   (0 rows ⇒ lost it)
-- ack: DELETE WHERE id=$1 AND locked_by=$2
-- nack: SET locked_by=NULL, locked_until=NULL, run_at=now()+least('15 min', 2s*2^attempts),
--       dead_at = CASE WHEN attempts>=max_attempts THEN now() END
```

Add `NOTIFY ocso_jobs` on enqueue plus `LISTEN` in workers to cut poll latency (UNVERIFIED: this is a design suggestion and I did not benchmark it). The Postgres adapter publishes its own `OldestReadyAgeSeconds` and `ReadyDepth`, the equivalents of the SQS metrics.

## 2. ECS Fargate autoscaling (worker)

- **Target tracking with a customized metric plus metric math:** supported (VERIFIED(types+docs)).
  - `CustomizedMetricSpecification.Metrics[]` takes `{Id, MetricStat|Expression, ReturnData}`. Exactly one expression has `ReturnData: true`.
  - The PutScalingPolicy payload is limited to 50 KB.
  - Target tracking evaluates at **1-minute** granularity.
  - Missing datapoints put the alarm in INSUFFICIENT_DATA and it will not scale, so publish zeros or use `FILL(m, 0)`.
  - The metric must fall as capacity rises.
  - Default ECS cooldowns are 300 s.
  - With multiple policies, it scales **out if any policy says so and in only if all agree**.
- **AWS's "backlog per task" example** is `ApproximateNumberOfMessagesVisible (Sum) / ECS/ContainerInsights RunningTaskCount (Average)`. It needs Container Insights (VERIFIED(docs)).
- **High resolution (20 s):** applies only to the **predefined** `ECSServiceAverage{CPU,Memory}UtilizationHighResolution` metrics, enabled via `--monitoring metricConfigurations=[…resolutionSeconds=20]` (June 2026, VERIFIED(docs)). The App Auto Scaling `TargetTrackingMetricStat` type has **no `Period` field** (VERIFIED(types)), so custom metrics stay at 1-minute resolution. CPU is not our signal anyway.

**OCSO signal design:**

- A leader-elected "fleet reporter" in the API reads Postgres once a minute and publishes these metrics (all `Dimensions: Service=worker`), zeros included:
  - `SlotDemand` = active leases + conversations waiting for a worker
  - `LiveWorkers` = workers with a fresh heartbeat
  - `OldestWaitingAgeSeconds`
- Publishing from the reporter rather than from each worker means scale-from-zero still gets data and there is no Container Insights dependency.
- Publishing options:
  - EMF line on stdout through the `awslogs` driver. The `x-amzn-logs-format` header is optional (VERIFIED(docs)).
  - Or `PutMetricData`: at most 1,000 metrics per call; `StorageResolution` 1 or 60 (VERIFIED(types)).

Terraform (VERIFIED(run): `terraform validate` and `fmt -check` pass with provider 6.66.0; excerpt, full version in `tf/{main,scaling}.tf`):

```hcl
resource "aws_appautoscaling_target" "worker" {
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${var.cluster_name}/worker"
  min_capacity       = 1
  max_capacity       = 10
  lifecycle { ignore_changes = [min_capacity, max_capacity] } # Tech Admin owns these at runtime
}
# in aws_appautoscaling_policy "worker_demand" (TargetTrackingScaling), target_value = 8  (10 slots × 0.8):
    customized_metric_specification {
      metrics {
        id          = "demand"
        return_data = false
        metric_stat {
          stat = "Sum"
          metric {
            namespace   = "OCSO/Scaling"
            metric_name = "SlotDemand"
            dimensions {
              name  = "Service"
              value = "worker"
            }
          }
        }
      }
      # metrics { id = "workers" … metric_name = "LiveWorkers", stat = "Average" }  (same shape)
      metrics {
        id          = "perw"
        expression  = "IF(workers > 0, demand / workers, demand)" # UNVERIFIED against CloudWatch: test with GetMetricData first
        return_data = true
      }
    }
# step scaling for bursts / scale-from-zero: alarm → StepScaling policy (ChangeInCapacity +1 at ≥30s, +3 at ≥90s)
resource "aws_cloudwatch_metric_alarm" "queue_age_high" {
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.jobs.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 30
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_appautoscaling_policy.worker_queue_age.arn]
}
```

**Runtime updates from the Tech Admin UI** (the "deployment adapter"): `RegisterScalableTarget` is idempotent. Calling it again updates Min, Max and `SuspendedState {DynamicScalingIn/OutSuspended, ScheduledScalingSuspended}`. `PutScalingPolicy` with the same `PolicyName` updates the policy. Step-scaling alarms are plain `PutMetricAlarm` calls. All of this is VERIFIED(types+docs), and the snippets compile.

| Tech Admin setting | Maps to |
|---|---|
| min / max workers | `RegisterScalableTarget.MinCapacity/MaxCapacity` |
| conversations per worker | Worker slot count (DB config read at lease time) **and** the target-tracking `TargetValue` = slots × utilisation |
| slot-utilisation threshold % | `TargetValue` (above) |
| queue age / depth threshold | `PutMetricAlarm.Threshold` on `ApproximateAgeOfOldestMessage` or `OldestWaitingAgeSeconds` |
| scale-out / scale-in cooldown | `ScaleOutCooldown` / `ScaleInCooldown` (TT) and `Cooldown` (step) |
| pause autoscaling | `SuspendedState` |

- **IAM for the API task role** (VERIFIED(docs)):
  - `application-autoscaling:{RegisterScalableTarget,DescribeScalableTargets,PutScalingPolicy,DescribeScalingPolicies,DeleteScalingPolicy,DescribeScalingActivities}`
  - `ecs:DescribeServices`, `ecs:UpdateService`
  - `cloudwatch:{PutMetricAlarm,DescribeAlarms,DeleteAlarms,PutMetricData}`
  - The docs policies use `Resource: "*"`.
- **Drift:** Terraform must `ignore_changes` on min/max, and should either not define the app-owned policies or ignore their configuration blocks. The same applies to `aws_ecs_service.desired_count`.

**Scale-in protection** (VERIFIED(docs+types)):

- **How to set it:**
  - From inside the task: `PUT $ECS_AGENT_URI/task-protection/v1/state {"ProtectionEnabled":true,"ExpiresInMinutes":N}`. N is 1–2,880, default 120.
  - Or the `UpdateTaskProtection` API (up to 10 tasks per call).
- **Requirements:**
  - The task role needs `ecs:UpdateTaskProtection` and `ecs:GetTaskProtection`.
  - Service tasks only.
- **What it covers:** it blocks scale-in *and* deployment replacement until cleared or expired. A rolling deploy waits, so raise `maximumPercent` to let new tasks start alongside protected ones.
- **Limits:**
  - More protected tasks than desired count gives `DEPLOYMENT_BLOCKED`.
  - CloudFormation stacks time out at 3 h while tasks stay protected.
  - Fargate `stopTimeout` is at most **120 s** (default 30).

**Recommendation:**

- Protect only while a **turn** is executing, not for the whole conversation, because leases can move between workers at turn boundaries.
  - Use a short expiry (for example 10 min) and refresh it.
  - Toggle only on 0↔>0 in-flight turns (API throttling limits UNVERIFIED).
- On SIGTERM:
  1. Stop claiming.
  2. Finish or checkpoint the current turn within about 100 s.
  3. Release leases (bump the version).
  4. Clear protection and exit.
- The reporter can also mark the least-loaded worker "draining" before a scale-in.

## 3. S3 (and blobs in Compose)

Presigning (VERIFIED(run) with 3.1137):

```ts
const s3 = new S3Client({ region, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
  ...(endpoint ? { endpoint, forcePathStyle: true } : {}) });           // S3-compatible store in Compose
const putUrl = await getSignedUrl(s3, new PutObjectCommand({ Bucket, Key, ContentType }),
  { expiresIn: 900, signableHeaders: new Set(["content-type"]) });      // client must send the same Content-Type
const getUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: "attachment" }), { expiresIn: 300 });
```

- **Checksum trap:**
  - With the default (`WHEN_SUPPORTED`), a presigned PUT carries `x-amz-checksum-crc32=AAAAAA==&x-amz-sdk-checksum-algorithm=CRC32`, which is the CRC32 of an empty body. Real uploads through it get rejected.
  - Presigned GETs carry `x-amz-checksum-mode=ENABLED`.
  - `WHEN_REQUIRED` removes both.
- **Expiry:** `expiresIn` above 604,800 throws "…less than one week" (VERIFIED(run)). Presigns made with task-role credentials also die when the STS session does (UNVERIFIED). Keep them in minutes.
- **SSE:**
  - Passing `ServerSideEncryption:"aws:kms"` into a presign makes the SSE headers **signed headers** that the browser must send (VERIFIED(run)). So set **bucket default encryption SSE-KMS + `bucket_key_enabled`** instead and don't pass SSE per request.
  - The signer role needs `kms:GenerateDataKey` for PUT and `kms:Decrypt` for GET.
  - SSE-S3 has been the baseline since 2023.
  - SSE-C is **disabled by default for new buckets since 2026-04-06** (VERIFIED(docs)).
- **Other bucket settings:** Block Public Access on, and a CORS rule for browser PUT/GET.

**MinIO status (VERIFIED(run) via APIs today):**

- Docker Hub `hub.docker.com/v2/repositories/minio/minio` returns **404**.
- GitHub `minio/minio` is **archived** (last push 2026-04-24).
- The only remaining images are on Quay (`quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z.hotfix.*`, last 2026-04-01), with no upstream patches. **Do not ship it.**

Alternatives checked today:

| Option | License | Status (2026-09) | Fit |
|---|---|---|---|
| **Local FS blob store** (our adapter) | n/a | – | **Default for Compose.** Simplest. The API serves blobs via its own HMAC-signed, short-TTL URLs, the same shape as presigned URLs. |
| SeaweedFS `chrislusf/seaweedfs` | Apache-2.0 | 4.47 (2026-09-14), very active | Optional `s3` profile. `weed server -s3` (port 8333). Supports presign. **Configure credentials.** Whether it defaults to anonymous access is UNVERIFIED. |
| RustFS `rustfs/rustfs` | Apache-2.0 | 1.0.0 GA on 2026-09-16 | Promising but only just 1.0. Revisit. |
| Versity S3 Gateway `versity/versitygw` | Apache-2.0 | v1.8.0 (2026-09-04) | S3 API over a POSIX directory. A good "same bytes on disk" option. |
| Garage `dxflrs/garage` | AGPL-3.0 | active | Fine to run unmodified, but a heavier cluster-oriented config. |
| LocalStack | – | GitHub repo **archived 2026-03-23**; images still published (`2026.08.3`) | Don't depend on it. Licensing terms UNVERIFIED. |

**Recommendation:** the `BlobStore` port gets `fs` (default in Compose) and `s3` adapters. `s3` points at AWS, or at SeaweedFS/Versity via `endpoint` + `forcePathStyle` for customers who want S3 semantics on one host.

## 4. Secrets

- **Reads in AWS:**
  - Bootstrap secrets (DB creds, session key) are injected through the task definition `secrets` field. The format is `arn:…:secret:NAME-AbCdEf:json-key:version-stage:version-id`, so `…:password::` picks one key.
  - This needs the **execution role** to hold `secretsmanager:GetSecretValue` (plus `kms:Decrypt` for a CMK).
  - Values are fixed at container start. Rotation needs a new deployment (VERIFIED(docs)).
  - For RDS use `manage_master_user_password = true`, where RDS owns the secret and its rotation.
- **Caching:**
  - JavaScript has **no official caching client**. AWS docs show plain `GetSecretValue`/`BatchGetSecretValue` for JS, while Java, Python, .NET, Go and Rust have one.
  - The "Secrets Manager Agent" is now the **AWS Workload Credentials Provider** (3.1.1): a local HTTP cache on :2773 with default TTL 300 s, an SSRF token and **read-only** access.
  - **Recommendation:** an in-process TTL cache (about 5 min) keyed by ARN. The API invalidates it on its own writes and broadcasts invalidation over Postgres `NOTIFY` to workers. No sidecar.
- **Runtime writes** (Tech Admin enters a provider key):
  1. `CreateSecret({Name: "ocso/providers/<provider>/<uuid>", SecretString, KmsKeyId, Tags})`, then store `ARN` in the DB.
  2. Updates use `PutSecretValue({SecretId: arn, SecretString})` (idempotent through the SDK-generated `ClientRequestToken`).
  3. Delete with `RecoveryWindowInDays` 7–30 (default 30). The name is blocked while the secret is pending deletion, so use unique names (VERIFIED(types)).
  4. IAM: allow `CreateSecret/PutSecretValue/GetSecretValue/DescribeSecret/DeleteSecret/TagResource` only on `arn:aws:secretsmanager:*:*:secret:ocso/providers/*`, and require the `app=ocso` tag on create (UNVERIFIED: condition-key details, check in the IAM policy simulator).
  5. Never return a value to the UI after write. Show only the last 4 characters and the version date.
- **Compose `local-envelope` store:**
  - Table `secret_store(id, name, dek_wrapped, dek_iv, dek_tag, ct, iv, tag, kek_version, created_at)`.
  - Encryption: a per-secret 256-bit DEK, `aes-256-gcm`, a 12-byte random IV, and AAD = `id|name|kek_version` to stop row swapping. The DEK is wrapped by the KEK, which is 32 bytes read from `/run/secrets/master_key`.
  - Rotation re-wraps DEKs.
  - **Tradeoffs:**
    - It protects DB dumps and backups, but **not a host compromise** because the key sits on the same box.
    - There is no audit trail or HSM, and losing the key file loses every secret, so back it up separately.
    - On EC2, an optional KEK in KMS via the instance role closes most of the gap.
    - Refuse to start if the key file is missing or its mode is broader than 0400.

## 5. IaC: Terraform (recommended) vs CDK

- **Versions (VERIFIED(run) via APIs):**
  - Terraform **1.16.3** (2026-09-16); 1.17.0-beta1 is out.
  - OpenTofu 1.12.6.
  - `hashicorp/aws` **6.66.0** (2026-09-21), so v6 is the current major.
  - Modules: `terraform-aws-modules` vpc 6.7.3, ecs 7.6.1, rds 7.2.2, alb 10.5.1, sqs 5.2.2.
  - CDK: `aws-cdk-lib` 2.270.0 and CLI 2.1142.0.
- **Why Terraform:**
  1. OCSO is single-tenant, so it often lands in *customer* accounts, where Terraform is the lingua franca and CDK needs `cdk bootstrap` (CloudFormation stack, bucket, roles).
  2. CloudFormation's 3 h update timeout interacts badly with task protection (see §2).
  3. It is easy to hand infra over to the customer's ops team.
- **CDK's real advantages:** TypeScript, and `QueueProcessingFargateService` includes queue-based step scaling. Neither outweighs the points above.
- **Validation without installing Terraform** (VERIFIED(run)). Bind-mount a dir under `/Users/…`, because `/private/tmp` mounts came up empty in this Docker VM:
  - `docker run --rm -v "$PWD":/w -w /w hashicorp/terraform:1.16.3 init -backend=false`
  - then `… validate` and `… fmt -check -recursive`
  - Add `tflint` (Docker image) in CI.

Skeleton:

```
infra/terraform/
  modules/
    network/        # VPC 2–3 AZ, public/private subnets, 1 NAT (or VPC endpoints: ecr.api, ecr.dkr, s3 gw, logs, sqs, secretsmanager, kms, sts, ecs, monitoring, xray)
    ecr/            # ocso-api, ocso-worker, ocso-web + lifecycle (keep N)
    alb/            # ALB, HTTPS listener (ACM), /api/* → api TG, default → web TG
    data/           # RDS postgres 18, manage_master_user_password, SG from app SGs only, backups, PI
    queue/          # ocso-turns (+DLQ, redrive, redrive_allow), DLQ depth alarm
    blobs/          # S3 bucket, KMS CMK, SSE-KMS default + bucket key, BPA, CORS, lifecycle
    secrets/        # KMS CMK for app secrets, bootstrap secrets, IAM policy doc for ocso/providers/* prefix
    observability/  # log groups (retention), Transaction Search enablement, dashboards, alarms
    ecs-cluster/    # cluster, FARGATE (+FARGATE_SPOT for worker optional)
    ecs-service/    # generic: task def, service, SG, exec+task roles, optional TG, scalable target (ignore_changes)
    migrate-task/   # task def only (same image as api, command=migrate)
  envs/prod/{main.tf, backend.tf (S3 backend, use_lockfile = true — UNVERIFIED today), prod.tfvars}
```

**Migrations** (a one-off ECS task, run from CI, because Terraform has no "run task" resource):

1. Register the task definition.
2. `aws ecs run-task --launch-type FARGATE --task-definition ocso-migrate:N --network-configuration …`
3. `aws ecs wait tasks-stopped`.
4. Assert `containers[0].exitCode == 0`.
5. Only then `update-service` on api, worker and web. Workers must tolerate N-1 schema (expand/contract migrations).

## 6. Docker Compose (Compose v5.x; local 5.1.3, latest 5.5.1)

VERIFIED(run): `docker compose config --quiet` passes. The file is trimmed here; full version at `compose/compose.yaml`.

```yaml
name: ocso
services:
  postgres:
    image: postgres:18                         # 18.6 today; 19 is beta3. PG18 image: VOLUME=/var/lib/postgresql, PGDATA=/var/lib/postgresql/18/docker
    environment: { POSTGRES_USER: ocso, POSTGRES_DB: ocso, POSTGRES_PASSWORD_FILE: /run/secrets/db_password }
    secrets: [db_password]
    volumes: [pgdata:/var/lib/postgresql]      # NOT …/data on 18+ (VERIFIED(docs))
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U ocso -d ocso"], interval: 5s, timeout: 3s, retries: 10, start_period: 20s }
    restart: unless-stopped
  migrate:
    image: ${OCSO_API_IMAGE}
    command: ["node", "dist/migrate.js"]
    depends_on: { postgres: { condition: service_healthy } }
    restart: "no"
  api:
    image: ${OCSO_API_IMAGE}
    secrets: [db_password, master_key]         # app reads *_FILE paths
    depends_on:
      postgres: { condition: service_healthy, restart: true }
      migrate:  { condition: service_completed_successfully }
    healthcheck: { test: ["CMD", "node", "-e", "fetch('http://localhost:3001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], interval: 10s, start_period: 30s }
    restart: unless-stopped
    stop_grace_period: 30s
  s3:             { profiles: [s3],   image: "chrislusf/seaweedfs:4.47", command: ["server", "-s3", "-dir=/data"] }
  otel-collector: { profiles: [otel], image: "otel/opentelemetry-collector-contrib:0.161.0" }
secrets:
  db_password: { file: ./secrets/db_password.txt }
  master_key:  { file: ./secrets/master_key.txt }
volumes: { pgdata: {}, blobs: {}, s3data: {} }
```

- `worker` (same `depends_on` as api, `stop_grace_period: 90s` to drain leases) and `web` (`depends_on: {api: {condition: service_healthy}}`) are omitted from the excerpt.
- No `version:` key.
- `depends_on.restart: true` restarts dependents when Postgres restarts.
- Profiles: `docker compose --profile s3 --profile otel up -d`.
- Pin image tags and digests in releases.
- The healthcheck uses Node's `fetch`, which avoids needing curl in slim images.

## 7. OpenTelemetry to CloudWatch

- **Native OTLP endpoints** (VERIFIED(docs)):
  - **Traces:** `https://xray.<region>.amazonaws.com/v1/traces`. SigV4 only. Requires **Transaction Search** to be enabled. Spans land in the `aws/spans` log group.
  - **Logs:** `https://logs.<region>.amazonaws.com/v1/logs`. Needs `x-aws-log-group` and `x-aws-log-stream` headers, and the group and stream must already exist. Auth is SigV4 or a bearer token.
  - **Metrics:** `https://monitoring.<region>.amazonaws.com/v1/metrics`. GA was announced 2026-06-16. It uses a new PromQL store with up to 150 labels, is priced per GB, and has PromQL alarms.
  - All endpoints are HTTP only (no gRPC), with gzip or none compression.
- **Collector-less path:** the ADOT Node distro `@aws/aws-distro-opentelemetry-node-autoinstrumentation` (0.13.0) supports it for traces and logs. Set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://xray.<r>.amazonaws.com/v1/traces` and start with `node --require '@aws/aws-distro-opentelemetry-node-autoinstrumentation/register'`.
  - The SDK default is 100% sampling. Set `OTEL_TRACES_SAMPLER=parentbased_traceidratio` and `OTEL_TRACES_SAMPLER_ARG=0.05`.
- **Sidecar option:** ADOT collector `amazon/aws-otel-collector` v0.50.0 (2026-08-31), or contrib + `sigv4authextension`. Only worth it for tail sampling or fan-out.
- **Recommendation:**
  - **Traces:** ADOT Node direct to X-Ray OTLP (no sidecar).
  - **Logs:** JSON to stdout via the `awslogs` driver (retention set in TF).
  - **Scaling metrics:** EMF/PutMetricData **classic** metrics, because target tracking needs `Namespace/MetricName/Dimensions`. Whether OTLP/PromQL alarms can drive App Auto Scaling policies is UNVERIFIED.
  - **App metrics:** optional OTLP to the metrics endpoint later.
- **In Compose:** plain OTel SDK to `otel-collector` (contrib) under the `otel` profile. Export anywhere, or to CloudWatch with `sigv4auth` when on EC2 with an instance role.

## Sources (fetched 2026-09-22)

- **SQS:** [message quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html) · [FIFO quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-fifo.html) · [visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html) · [high-throughput FIFO](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/high-throughput-fifo.html) · [fair queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-fair-queues.html) · [DLQs](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html) · [metrics](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-available-cloudwatch-metrics.html)
- **App Auto Scaling:** [metric math](https://docs.aws.amazon.com/autoscaling/application/userguide/application-auto-scaling-target-tracking-metric-math.html) · [target tracking](https://docs.aws.amazon.com/autoscaling/application/userguide/target-tracking-scaling-policy-overview.html) · [IAM](https://docs.aws.amazon.com/autoscaling/application/userguide/security_iam_id-based-policy-examples.html)
- **ECS:** [task protection](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-scale-in-protection.html) · [task protection endpoint](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-scale-in-protection-endpoint.html) · [high-res scaling](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/target-tracking-faster-auto-scaling.html) · [secrets injection](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html)
- **Secrets Manager:** [Workload Credentials Provider](https://docs.aws.amazon.com/secretsmanager/latest/userguide/secrets-manager-agent.html) · [JS retrieval](https://docs.aws.amazon.com/secretsmanager/latest/userguide/retrieving-secrets-javascript.html)
- **CloudWatch:** [OTLP endpoints](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTLPEndpoint.html) · [ADOT collector-less](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTLP-UsingADOT.html) · [OTel metrics GA](https://aws.amazon.com/about-aws/whats-new/2026/06/amazon-cloudwatch-otel-metrics/) · [PromQL](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-PromQL.html) · [EMF via PutLogEvents](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Generation_PutLogEvents.html)
- **S3:** [SSE-C default change](https://aws.amazon.com/blogs/storage/advanced-notice-amazon-s3-to-disable-the-use-of-sse-c-encryption-by-default-for-all-new-buckets-and-select-existing-buckets-in-april-2026/) · [SDK JS checksums](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/s3-checksums.html)
- **RDS:** [PG 18 support](https://aws.amazon.com/about-aws/whats-new/2025/11/amazon-rds-postgresql-major-version-18/) · [18.6 minor](https://aws.amazon.com/about-aws/whats-new/2026/08/amazon-rds-postgresql-18-6-17-11-16-15-15-19-14-24/)
- **Images and tools:** [postgres image](https://hub.docker.com/_/postgres) · [compose releases](https://github.com/docker/compose/releases) · MinIO: Docker Hub API 404 and GitHub API `archived: true`
