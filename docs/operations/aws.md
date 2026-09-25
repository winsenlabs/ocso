# Running OCSO on AWS (ECS Fargate)

This runbook covers the Terraform in `infra/aws/terraform` (ADR-022). It uses the same four images
and the same application code as Docker Compose. Only configuration changes: `QUEUE_DRIVER=sqs`,
`BLOB_DRIVER=s3`, `SECRETS_DRIVER=aws` and `DEPLOYMENT_DRIVER=ecs`.

```
                    ┌──────────── public subnets ────────────┐
 customers, staff ──► ALB :443  (HTTP :80 → 301 to HTTPS)
                    │   /channels/* /public/* /oauth/*        │
                    │   /.well-known/* /blobs/* /health/*  ───┼──► api  :4000 ─┐
                    │   everything else                    ───┼──► web  :3000  │  (web → api:4000 over
                    └─────────────────────────────────────────┘                │   ECS Service Connect)
                    ┌──────────── private subnets ────────────────────────────┐ │
                    │ api ×N   worker ×(autoscaled)   migrate (one-off task)  │◄┘
                    │   │  SQS (10 topic queues + DLQs)  S3 media (SSE-KMS)    │
                    │   └─► RDS PostgreSQL (Multi-AZ, TLS, CMK)  ── NAT ──► providers, MCP servers
                    │   └─► RDS PostgreSQL for the audit store (own instance) │
                    └─────────────────────────────────────────────────────────┘
```

> **Not validated.** The audit store additions in this release (`audit.tf`, `variables-audit.tf`, the
> new bootstrap keys and task secrets) have not been run through `terraform validate`, let alone
> `plan` or `apply`. Treat everything below about the audit store as the intended shape, derived from
> the Terraform source, until a staging apply confirms it.

Browsers only ever talk to `web`. The API's `/v1/*` control plane is not routed by the ALB (ADR-020).
Better Auth's `/api/auth/*` (ADR-025) must stay on the **web** target group (the default rule, no
change needed): the web app forwards it to the API and sets the client address used for sign-in rate
limits from its trusted proxy hop (`OCSO_TRUSTED_PROXY_HOPS=1` behind the ALB). Routing `/api/auth/*`
straight to the api target group would let browsers choose that address themselves.

## 1. What Terraform creates

| Module | Contents |
|---|---|
| `network` | VPC; public and private subnets in 2–3 AZs; NAT gateway per AZ (or one with `single_nat_gateway`); S3 gateway endpoint |
| `alb` | Public ALB with TLS 1.3/1.2 policy and `drop_invalid_header_fields`. Path rules send public ingress to the api target group and everything else to web |
| `ecs-cluster` | Cluster with FARGATE and FARGATE_SPOT, Container Insights, and a Service Connect namespace |
| `service` (×3) | Task definition and service for **api**, **web** and **worker**: awslogs, `initProcessEnabled`, circuit breaker with rollback, optional OTel collector sidecar |
| `migrate-task` | Task definition only; you run it with `aws ecs run-task` |
| `rds` | PostgreSQL `18` (major pinned, RDS picks the minor), gp3, CMK encryption, `rds.force_ssl=1`, PITR backups, Performance Insights, deletion protection |
| `audit_rds` (`audit.tf`) | The audit store's own RDS instance (ADR-032), same module, sized by `audit_store` (default `db.t4g.small`, Multi-AZ, 35-day backups). Its master user `ocso_audit` owns the audit database, and only the migrate task receives it. `audit_store.separate_instance = false` puts the audit database on the main instance instead, which a `check` block warns about on every plan: the api and worker then hold credentials that can alter it |
| `sqs` | One Standard queue and one DLQ per topic in `packages/queue/src/contract.ts`, redrive, TLS-only policy, DLQ-not-empty alarms |
| `s3` | Media bucket: CMK default encryption with a bucket key, Block Public Access, ACLs disabled, TLS-only, versioning, CORS for the public origin, TEMP and multipart-upload lifecycle rules |
| `secrets` | `ocso/<env>/bootstrap` (CMK) and the IAM policy documents for the runtime prefix `ocso/<env>/app/*`. The audit signing key is a separate secret you create (§6) |
| `iam` | Execution roles (app, web) and task roles (api, worker, web, migrate). Scaling permissions belong to the worker role only |
| `ecr` | `ocso-api`, `ocso-worker`, `ocso-web`, `ocso-migrate`: immutable tags, scan on push, lifecycle rules |
| `autoscaling` | Worker scalable target, target tracking on OCSO demand metrics, step scaling on SQS queue age |
| `observability` | SNS alarm topic (CMK) and alarms for ALB 5xx, unhealthy targets, RDS CPU/storage/memory and turn backlog |

**Validating without installing Terraform** (CI does the same). Mount the directory from a path under
`/Users/…`; mounts from `/private/tmp` come up empty in Colima.

```bash
cd infra/aws/terraform
docker run --rm -v "$PWD":/w -w /w hashicorp/terraform:1.16.3 init -backend=false
docker run --rm -v "$PWD":/w -w /w hashicorp/terraform:1.16.3 validate
docker run --rm -v "$PWD":/w -w /w hashicorp/terraform:1.16.3 fmt -check -recursive
```

Requires Terraform ≥ 1.11 (write-only attributes), AWS provider 6.x (locked at 6.66.0) and random ≥ 3.7.

## 2. Prerequisites

- An AWS account and region. Check that PostgreSQL 18 is offered there:
  `aws rds describe-db-engine-versions --engine postgres --engine-version 18 --query 'DBEngineVersions[].EngineVersion'`.
  If it is not, set `db.engine_version = "17"` and `db.parameter_group_family = "postgres17"`.
- An **ACM certificate** in the same region for `public_hostname`.
- A **state bucket** (one-time; versioned, encrypted, private):
  ```bash
  aws s3api create-bucket --bucket acme-terraform-state --region ap-south-1 \
    --create-bucket-configuration LocationConstraint=ap-south-1
  aws s3api put-bucket-versioning --bucket acme-terraform-state --versioning-configuration Status=Enabled
  aws s3api put-public-access-block --bucket acme-terraform-state \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  ```
  Uncomment the `backend "s3"` block in `versions.tf` (`use_lockfile = true`: no DynamoDB table needed).
  The state holds no secret values (see §6), but it does describe your infrastructure, so keep it private.
- **The audit signing key** (required; created outside Terraform, so it never follows bootstrap
  rotations and never enters state):
  ```bash
  openssl genpkey -algorithm ed25519 -out audit_signing_key.pem
  aws secretsmanager create-secret --name ocso/prod/audit-signing-key --secret-string file://audit_signing_key.pem
  ```
  Put its ARN in `audit_signing_key_secret_arn` (and `audit_signing_key_kms_key_arn` if you encrypt it
  with your own CMK). Keep a copy of the PEM with your backups.
- `cp terraform.tfvars.example terraform.tfvars` and edit it. `*.tfvars` files are git-ignored.

## 3. First deployment (apply order)

```bash
cd infra/aws/terraform
terraform init

# 1. Repositories first, so there is somewhere to push.
terraform apply -target=module.ecr

# 2. Build and push the four images with one immutable tag.
TAG=2026.09.22-1
ACCOUNT=$(aws sts get-caller-identity --query Account --output text); REGION=ap-south-1
REGISTRY=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $REGISTRY
for target in api worker web migrate; do
  # from the repository root; APP_VERSION is reported by the app and its telemetry
  docker build --target $target --build-arg APP_VERSION=$TAG -t $REGISTRY/ocso-$target:$TAG .
  docker push $REGISTRY/ocso-$target:$TAG
done
```

- **Architecture.** Images must match `cpu_architecture`. The default is `X86_64`, which is what CI
  runners build. To run on Graviton, build `linux/arm64` images (for example on an arm64 runner) and set `ARM64`.
- **The web image bakes `API_URL=http://api:4000` into its Next.js rewrites.** On ECS the API is
  published through Service Connect under exactly that name, so one image works in Compose and on AWS.
  (On AWS the ALB sends the public-ingress paths to the API directly, so the rewrites are only a fallback.)

```bash
# 3. Everything except the ECS services (deploy_services = false in tfvars).
terraform apply -var image_tag=$TAG

# 4. Run migrations (section 4).

# 5. Start the services.
terraform apply -var image_tag=$TAG -var deploy_services=true
```

6. **DNS.** Set `route53_zone_id` to get an alias record. Otherwise point `public_hostname` at the
   `alb_dns_name` output.
7. **First-run setup.** Every API task reads the same setup token from the bootstrap secret. A per-task
   random token would make setup fail on every other request.
   ```bash
   aws secretsmanager get-secret-value --secret-id "$(terraform output -raw bootstrap_secret_arn)" \
     --query SecretString --output text | jq -r .OCSO_SETUP_TOKEN
   ```
   Open `https://<public_hostname>/setup` and create the first Tech admin. The token stops working once
   setup is complete. Configuration changes then need a second person's approval (ADR-030). While that
   admin is the only one who can check, they approve their own platform changes and new users as
   recorded bootstrap approvals ([setup guide](setup-guide.md)).

## 4. Migrations (every deploy)

Migrations are an explicit step and never run on api or worker boot (docs/13 §5, ADR-004). Terraform only
registers the task definition. The migrate image runs two steps: the main migrations
(`dist/bin/migrate.js`), then `audit-migrate` (`audit-store/dist/bin/audit-migrate.js`). The second step
creates the audit database if it is missing, applies its schema, creates the `ocso_audit_writer` and
`ocso_audit_reader` roles and sets the minimum retention (`AUDIT_MIN_RETENTION_DAYS`, from
`audit_store.min_retention_days`, at least 365). Only the migrate task receives
`AUDIT_DATABASE_OWNER_URL`.

```bash
cd infra/aws/terraform
TAG=2026.09.23-1
# Register the migrate task definition for the new image, nothing else.
terraform apply -target=module.migrate -var image_tag=$TAG

CLUSTER=$(terraform output -raw cluster_name)
TASK_ARN=$(aws ecs run-task --cluster "$CLUSTER" --launch-type FARGATE \
  --task-definition "$(terraform output -raw migrate_task_definition_arn)" \
  --network-configuration "$(terraform output -raw migrate_network_configuration)" \
  --started-by "deploy-$TAG" --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"
EXIT=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[?name==`migrate`].exitCode | [0]' --output text)
aws logs tail "$(terraform output -raw migrate_log_group)" --since 15m
[ "$EXIT" = "0" ] || { echo "migration failed (exit $EXIT); services NOT updated"; exit 1; }

# Only now roll the services to the new image.
terraform apply -var image_tag=$TAG
```

- `aws ecs wait tasks-stopped` gives up after 10 minutes. Re-run it for a long migration; the task keeps going.
- The runner takes a `pg_advisory_lock`, so two concurrent runs serialize safely. It refuses to run if an
  applied migration file was edited.
- **Expand/contract rule.** While a deploy rolls, tasks of version N-1 and N run side by side against the
  new schema. Migrations must therefore be additive: add nullable columns and tables, backfill in the
  application, and drop or rename only in a *later* release. This is also what makes image rollback safe.
  **The governance and routing release breaks this rule** (below): migration 0021 renames the stored roles,
  and the previous image fails on every authenticated request once it has run.
- **Rollback.** Within releases that follow the rule, apply the previous `image_tag`. Schema rollbacks are
  forward fixes (a new migration), never down-migrations. Rolling back past the governance and routing
  release is different: restore the pre-upgrade RDS snapshot; the previous `image_tag` alone does not work.

### Upgrading an existing deployment to the governance and routing release

Not tested on AWS; the steps follow from the Terraform source.

This release is one-way. Rolling back past it means restoring the snapshot from step 1 to the main
instance (the audit RDS instance is new and can be deleted), which discards everything since the
upgrade. Redeploying the previous `image_tag` against the migrated database locks out every signed-in
user, because the previous release does not know the renamed roles (migration 0021).

1. **Back up first (required).** Take a manual RDS snapshot of the main instance
   (`aws rds create-db-snapshot`). It is the only way back: there are no down-migrations and the previous
   image does not run against the migrated schema.
2. **Create the audit signing key secret** (§2) and set `audit_signing_key_secret_arn`.
3. **Bump `bootstrap_secret_version`.** The bootstrap JSON gains `AUDIT_DATABASE_URL`, `AUDIT_READER_URL`
   and `AUDIT_DATABASE_OWNER_URL`, but Terraform writes the secret only when the version changes. The
   bump also rotates the main database password and the setup token (§6 rotation), so do it in a quiet
   window.
4. `terraform apply -var image_tag=$TAG` creates the audit RDS instance and rewrites the bootstrap secret.
   Before running the migrate task, scale api, worker and web to zero
   (`aws ecs update-service --desired-count 0`), or accept that tasks of the old release return errors
   to signed-in users from the moment 0021 applies until the new tasks replace them.
   Then run the migrate task as above. It applies migrations 0021–0031, then `audit-migrate`
   provisions the audit store. Only then roll the api and worker (`--force-new-deployment` if the image
   tag did not change), because tasks started before the bump hold the old database password.
5. Watch **System → Audit store** until the backlog of historic audit events has shipped. Then verify
   the chain (below).

Roles are mapped automatically: Platform Tech Admin → Tech, CS Lead → Head, CS Exec → Service
(migration 0021). Everything already live is recorded as approved (migration 0031), so it keeps
running. Its next change is a proposal.

**Verifying the audit chain.** Use the System screen (**Verify recent entries**, `audit.verify`) or
`POST /v1/audit/verify`. The offline `audit-verify` bin ships in the migrate image
(`node audit-store/dist/bin/audit-verify.js --from 1 --public-key <file>`). It needs `AUDIT_DATABASE_URL`
(the reader URL is enough) and a public key you pinned yourself (`GET /v1/audit/keys`). The migrate task
definition carries neither the signing key nor a pinned key file, so run the bin from a host inside
the VPC with those settings. There is no ready-made ECS task for it.

## 5. Routine operations

| Task | How |
|---|---|
| Deploy a release | Build and push the 4 images with a new tag → section 4 |
| Roll back | `terraform apply -var image_tag=<previous>` (the ECR lifecycle keeps the last 30 tags). Not past the governance and routing release: restore the pre-upgrade snapshot instead (section 4) |
| Restart a service | `aws ecs update-service --cluster <c> --service api --force-new-deployment` |
| Shell into a task (break glass) | `enable_execute_command = true`, apply, then `aws ecs execute-command --cluster <c> --task <id> --container api --interactive --command sh` |
| API/web capacity | `aws ecs update-service --desired-count N`. Terraform ignores `desired_count` after creation |
| Egress IPs for MCP allowlists | `terraform output nat_public_ips` |

## 6. Secrets

**Bootstrap secret** `ocso/<env>/bootstrap` is a JSON document encrypted with its own CMK:

| Key | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | api, worker, migrate | `postgres://ocso:<pw>@<rds-endpoint>:5432/ocso`, used with `DATABASE_SSL=true` |
| `OCSO_SETUP_TOKEN` | api | Must be identical across API tasks |
| `AUDIT_DATABASE_URL` | worker (as `AUDIT_DATABASE_URL`), migrate | The audit store writer `ocso_audit_writer` (INSERT/SELECT only) |
| `AUDIT_READER_URL` | api (injected as `AUDIT_DATABASE_URL`), migrate | The audit store reader `ocso_audit_reader` (SELECT only) |
| `AUDIT_DATABASE_OWNER_URL` | migrate only | The audit database owner (`ocso_audit` on the separate instance), used by `audit-migrate` |
| `BETTER_AUTH_SECRET` | api | **Needed before the next AWS rollout (ADR-025; Terraform not yet updated).** ≥ 32 random characters, identical across API tasks; signs session cookies and encrypts authenticator secrets. The api refuses to start in production without it |

- **Audit signing key.** Its own secret (`audit_signing_key_secret_arn`, created by you, §2), injected
  as `AUDIT_SIGNING_KEY` into the api (it signs exception reports) and the worker (checkpoints and
  exports). The app execution role gets `GetSecretValue` on that one ARN. Retired public keys go in
  `audit_trusted_public_keys` (plain environment, not secret).
- **Injection.** ECS injects these keys at task start (`valueFrom: <arn>:<key>::`) through the **app
  execution role**. That role may only `GetSecretValue` this one secret and decrypt with its CMK via
  Secrets Manager. The web execution role cannot read it.
- **Values never touch state.** Terraform generates them as `ephemeral "random_password"` values. It
  writes them through write-only attributes: `aws_db_instance.password_wo` and
  `aws_secretsmanager_secret_version.secret_string_wo`.
  - Both writes use the value from the same run, so the RDS password and `DATABASE_URL` always agree.
  - The values are sent only when `bootstrap_secret_version` changes.
- **TLS.** The images contain the RDS global CA bundle at `/etc/ssl/certs/rds-global-bundle.pem`, and
  `NODE_EXTRA_CA_CERTS` points at it, so `pg` verifies the server certificate (`rejectUnauthorized: true`).
- **Why not `manage_master_user_password`?** RDS-managed rotation changes the password on its own
  schedule. ECS only injects secrets at task start, so running tasks would keep the old password. Pooled
  connections survive, but every *new* connection would fail until a redeploy. Rotation here is a
  deliberate, coordinated step instead.

**Rotation** (DB password, setup token and the audit writer, reader and owner passwords rotate together; customer-claims signing keys are managed and
rotated inside OCSO — Settings API `POST /v1/security/signing-keys/rotate`):

1. Set `bootstrap_secret_version` to the next number, then `terraform apply`. RDS gets the new password
   and the secret gets the new JSON in the same run.
2. Run the migrate task (§4): `audit-migrate` sets the audit writer and reader roles to their new
   passwords. Then immediately `aws ecs update-service --force-new-deployment` for **api** and **worker**.
   - Until they roll, existing pooled connections keep working but new connections from old tasks fail.
   - Do this in a quiet window.
3. **Bump the version whenever the DB instance is replaced.** This applies to a new identifier and to a
   restore managed by Terraform. Otherwise the new instance gets a fresh ephemeral password that the
   secret does not contain.

**Runtime secrets** are provider API keys, channel tokens and MCP credentials entered in the UI. The app
writes them itself under `SECRETS_NAME_PREFIX=ocso/<env>/app` (`ocso/<env>/app/<ref>`), and PostgreSQL
stores only the ARN.
- The api and worker task roles may Create, Get, Put, Describe, Delete and Tag secrets under that prefix
  only.
- `CreateSecret` must carry the `ocso:kind` tag, and tagging is limited to the `ocso:ref` and `ocso:kind` keys.
- These secrets use the account's `aws/secretsmanager` key, because the app does not pass a CMK.
- Deleted secrets are recoverable for the app's recovery window (`aws secretsmanager restore-secret`).

### Model providers on AWS

Bedrock can authenticate with access keys or an API key (entered under Integrations → Models, stored in
Secrets Manager) or with the **task role** (provider auth mode `IAM_ROLE`). For the task role, list the
model and inference-profile ARNs in `bedrock_model_arns`; Terraform then grants the api and worker roles
`bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on exactly those ARNs. Other providers
(Vertex, Foundry, OpenAI, Anthropic, Sarvam) use credentials stored through the UI; they need outbound
HTTPS from the private subnets (NAT).

## 7. Worker autoscaling

Terraform declares the **shape**:
- the scalable target
- a target-tracking policy `<prefix>-worker-slot-demand` on `SlotDemand` (Sum) ÷ `Workers` (Average),
  both with dimension `Service=worker` in namespace `OCSO_METRICS_NAMESPACE`. Target = conversations per
  worker × target utilization.
- a step-scaling policy `<prefix>-worker-queue-age` with alarm `<prefix>-worker-queue-age-high` on the
  `conversation.turn` queue's `ApproximateAgeOfOldestMessage`: +1 task at ≥ threshold, +3 tasks at
  ≥ threshold + 60 s

Min/max, the policy configurations and the alarm threshold carry `lifecycle.ignore_changes`, so
`terraform apply` never reverts runtime changes. The `worker_scaling` output lists the exact names.

**Who owns runtime scaling.** OCSO's ECS deployment adapter runs in the **worker leader** (ADR-018
advisory-lock leadership, ADR-023). It publishes the scaling metrics and maps the Tech worker
settings onto the target, the policies (updated by name, since `PutScalingPolicy` is an upsert) and the
step-scaling alarm. The **worker** task role therefore has, and the api task role does **not**:

| Permission | Scope |
|---|---|
| `application-autoscaling:RegisterScalableTarget`, `PutScalingPolicy`, `DeleteScalingPolicy` | The worker's scalable-target ARN |
| `application-autoscaling:Describe{ScalableTargets,ScalingPolicies,ScalingActivities}` | `*` (no resource types; read-only) |
| `cloudwatch:PutMetricData` | Condition `cloudwatch:namespace = OCSO_METRICS_NAMESPACE`, which defaults to `OCSO/<name>-<env>`, e.g. `OCSO/ocso-prod`, so environments sharing an account never mix metrics |
| `cloudwatch:PutMetricAlarm`, `DeleteAlarms` | Alarms named `<ECS_CLUSTER>-worker-*` (the cluster name equals the prefix) |
| `cloudwatch:DescribeAlarms` | `*` (read-only; name-scoping would break prefix listing) |
| `ecs:DescribeServices` | The worker service |
| `ecs:UpdateTaskProtection`, `ecs:GetTaskProtection` | Tasks in this cluster |

The worker receives `DEPLOYMENT_DRIVER=ecs`, `ECS_CLUSTER`, `ECS_WORKER_SERVICE` and
`OCSO_METRICS_NAMESPACE`. The api receives the first three as well, because shared config validation
requires them when the driver is `ecs`, but its role cannot act on them.

- **Service-linked role.** Registering a scalable target needs `AWSServiceRoleForApplicationAutoScaling_ECSService`.
  AWS creates it the first time Terraform registers the worker target (with the deployer's
  `iam:CreateServiceLinkedRole`), so the worker role never needs IAM permissions. If an SCP blocks
  service-linked role creation, create it once with
  `aws iam create-service-linked-role --aws-service-name ecs.application-autoscaling.amazonaws.com`.
- **Recreated target.** If the scalable target is ever recreated (for example after `deploy_services`
  goes false and back to true), its ARN changes. The next `apply` updates the worker policy with the new ARN.
- ECS scales out if **any** policy asks and scales in only when **all** agree.
- **Scale-in protection.** The worker turns protection on only while a turn runs.
- **Draining.** Workers get `stopTimeout = 120` (the Fargate maximum) to finish or checkpoint a turn and
  release their lease. The service's `maximum_percent = 200` lets deploys start new tasks beside
  protected ones.
- **Fargate Spot.** `worker.use_spot` puts the warm floor on on-demand FARGATE and the burst on
  FARGATE_SPOT. Spot tasks can be reclaimed with 2 minutes' notice; leases make that safe but slower.

> **Runtime behaviour** is described in [worker-scaling.md](worker-scaling.md). In short:
> - The worker leader publishes the metrics every 60 s and reconciles settings every 5 min and on every change.
> - It rewrites the target-tracking metric math with `Average` for both inputs.
> - It changes only the queue-age alarm's threshold.
> - With autoscaling off it pins min = max.
> - The outcome shows in `GET /v1/settings/workers` (`scaling`).
>
> Before relying on target tracking, check the metric-math expression with `aws cloudwatch
> get-metric-data` against real data (ADR-023).

## 8. Observability

- **Logs.** Every container writes JSON (pino) to stdout, and `awslogs` ships it to `/ecs/<prefix>-<service>`
  with `log_retention_days`. Log lines carry `trace_id`/`span_id` when OTel is on.
  - The driver runs in `non-blocking` mode with a 25 MB buffer, so CloudWatch back-pressure drops log
    lines instead of stalling requests.
- **Traces and metrics (optional).** Set `otel_collector.enabled = true`. This adds an
  `otel/opentelemetry-collector-contrib` sidecar to the api and worker tasks, configured from the
  `OTELCOL_CONFIG` env var in `otel.tf`, and sets `OTEL_ENABLED=true` and
  `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`.
  - Traces go to the CloudWatch/X-Ray OTLP endpoint, signed with SigV4 using the task role (managed
    policy `AWSXrayWriteOnlyAccess`). Sampling is `parentbased_traceidratio` at `traces_sample_ratio`.
  - Metrics go through EMF into `/<prefix>/otel-metrics`, namespace `OCSO/App`.
  - OTLP logs are dropped because stdout already covers them.
  - The sidecar is `essential = false`, so telemetry failures never stop the app.
  - **One-time account step:** enable **X-Ray Transaction Search** (CloudWatch console → Settings → X-Ray
    traces → Transaction Search, or `aws xray update-trace-segment-destination --destination CloudWatchLogs`
    after adding the CloudWatch Logs resource policy described in the AWS docs). Without it the OTLP
    traces endpoint rejects spans.
- **Alarms** publish to the `alarm_topic_arn` SNS topic; subscribe `alarm_email_addresses` or chat
  tooling. Alarms cover:
  - ALB 5xx
  - target 5xx and unhealthy targets per service
  - RDS CPU, free storage and freeable memory
  - `conversation.turn` backlog above 120 s for 5 minutes
  - any DLQ with messages
  Product alerts (escalation rate, SLA, provider health) are OCSO's own alert engine, not CloudWatch.
- **Container Insights (enhanced)** is on by default for task CPU and memory. It is not an OCSO scaling
  signal.

## 9. Backup and recovery expectations

| Asset | Protection | Recovery |
|---|---|---|
| PostgreSQL (all business state) | Multi-AZ synchronous standby; automated backups with PITR (`backup_retention_days`, default 14); final snapshot on delete; deletion protection | AZ failure: automatic failover in ~1–2 min, same endpoint. Data loss or corruption: point-in-time restore (RPO ≈ 5 min) to a *new* identifier, then swap identifiers (rename the old one to `-old`, the restored one to the original). The endpoint name, and so `DATABASE_URL`, stays valid. The password is the one current at the restore point. Then `terraform apply` to re-assert settings, and force new deployments |
| Media (S3) | Versioning; noncurrent versions kept `noncurrent_expiry_days`; SSE-KMS; TLS-only | Restore a previous object version. Keys scheduled for deletion have a 30-day window: **never delete the bucket CMK** |
| Bootstrap secret | CMK; 30-day recovery window | `aws secretsmanager restore-secret`, or re-generate with a `bootstrap_secret_version` bump |
| Runtime secrets | Secrets Manager; app recovery window | `restore-secret`. The DB holds the ARNs |
| Queues | Messages are wake-ups, and the work is in PostgreSQL | Lost messages are recovered by the lease-recovery sweep. DLQ: fix the cause, then `aws sqs start-message-move-task --source-arn <dlq-arn>` to redrive |
| Conversations after task loss | Leases expire (default 45 s) and another worker resumes from persisted interactions, prompt version and tool-call records (docs/10 §9) | Automatic. No sticky routing is needed |
| Audit store (RDS) | Its own instance: Multi-AZ, PITR (`audit_store.backup_retention_days`, default 35) | Restore the audit instance like the main one, promptly: events shipped after the restore point are re-shipped only while they are inside the local window (`audit_local_window_days`). Then run `audit-verify` (compose.md §5 describes the chain after a store restore) |
| Audit signing key | Your own Secrets Manager secret | Keep the PEM with your backups. A lost key opens `SIGNING_KEY_CHANGED`; restore it rather than trusting a new one |
| Signed audit exports | `audit-exports/` in the media bucket (versioned) | **Not write-once:** Terraform does not enable S3 Object Lock and OCSO does not check it. Configure Object Lock yourself if exports must be an independent copy |
| Terraform state | Versioned S3 bucket | Restore a prior object version |

Out of scope today: cross-region disaster recovery. Add cross-region snapshot copy and S3 replication if the
organization needs a regional RTO.

## 10. Known gaps and follow-ups

0. **Authentication (ADR-025) is not yet in Terraform.** Add `BETTER_AUTH_SECRET` to the bootstrap
   secret and the api task definition, `SESSION_COOKIE_SECURE=true` for the api, `OCSO_PUBLIC_URL` for
   the web task, and keep `/api/auth/*` on the web target group (above). `OCSO_RECOVERY_TOKEN` is set
   only for a break-glass recovery and removed afterwards.

1. **Scaling metric math is unvalidated.** The worker's ECS deployment adapter now publishes the
   signals, applies runtime policies and toggles task protection (§7, worker-scaling.md). The
   `IF(workers > 0, demand / workers, demand)` expression still needs a GetMetricData check against real
   data (ADR-023).
2. **TEMP blob lifecycle.** Resolved: the S3 blob store tags TEMP objects `ocso-retention=TEMP`
   (the task roles hold `s3:PutObjectTagging`), which the `expire-temp-tag` lifecycle rule matches.
3. **Verified only with `terraform validate` / `fmt`.** No `plan`/`apply` has been run against a real
   account yet. Engine availability, quotas and Service Connect behaviour need a staging apply.
4. No AWS WAF on the ALB. Recommended: managed rule groups plus rate limits on `/channels/*` and
   `/public/*`.
5. No VPC interface endpoints. AWS API traffic (ECR, Secrets Manager, SQS, Logs) goes through NAT. Add
   endpoints to cut NAT cost or to remove internet egress for AWS APIs.
6. Rotation is all-or-nothing: the DB password, signing key and setup token rotate together (§6).
7. RDS enhanced monitoring is off: `monitoring_interval_sec` > 0 needs a monitoring role, which is not
   created.
8. Single region, with no cross-region backups (§9).
9. **Email is not wired in Terraform yet** (AWS work is on hold). api and worker refuse to start in
   production without it (compose.md §9). Needed on both task definitions:
   - plain environment: `EMAIL_DRIVER=resend`, `EMAIL_FROM` (on a domain verified in Resend),
     optionally `EMAIL_REPLY_TO`;
   - secret: `RESEND_API_KEY` injected from Secrets Manager (`valueFrom`), e.g. a new key in the
     bootstrap JSON or its own secret readable by the app execution role only. Alternatively
     `EMAIL_DRIVER=smtp` with `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` and `SMTP_PASSWORD` as a secret
     (SES SMTP credentials work);
   - egress: HTTPS to `api.resend.com` (already allowed through NAT), or the SMTP port for `smtp`.
10. **The audit store Terraform is not validated** (not even `terraform validate`): `audit.tf`,
    `variables-audit.tf`, the three new bootstrap keys, the signing-key IAM policy and the task secrets
    need a staging apply. The upgrade path (§4) has not been run.
11. **S3 Object Lock is not enforced** on `audit-exports/`. Exports are signed and verifiable, but they
    are only an independent copy once you enable write-once storage yourself.
12. With `audit_store.separate_instance = false` the append-only guarantee does not hold against a
    compromised api or worker (they hold the main master credentials). Use a separate instance for a bank.
