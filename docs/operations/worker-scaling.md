# Worker scaling: Compose and ECS

How OCSO's worker capacity settings work, what the worker leader applies on Docker Compose and on ECS
Fargate, and how to read and fix the scaling status. For Tech admins and operators.

A Tech admin sets worker capacity in OCSO under **Platform → Workers**. A change is a settings proposal
(ADR-030): the form's **Submit for approval** sends `PATCH /v1/settings/workers` with an `approval`
(202); without one the API answers 409 `approval_required`. A **deployment adapter** in the worker maps
the logical settings onto whatever the platform can enforce (ADR-023). The product code is the same on
both platforms; only `DEPLOYMENT_DRIVER` differs (`compose` or `ecs`). Deployment drivers are plugins,
registered in `packages/bootstrap`.

## The settings

| Field on **Platform → Workers** | Meaning | Enforced by |
|---|---|---|
| **Min warm workers** / **Max workers** | Fleet floor and ceiling | ECS: the scalable target. Compose: advisory. |
| **Conversations per worker** | Turns one worker runs at once | Every worker, on every platform |
| **Target utilization** | Share of slots in use that autoscaling aims for | ECS target tracking |
| **Scale out at queue age** / **Scale out at queue depth** | Scale-out triggers | ECS alarm threshold / `SlotDemand` |
| **Scale-in cooldown** | Seconds between scale-in steps | ECS target tracking |
| **Turn timeout**, **Lease duration**, **Heartbeat interval**, **Idle lease release** | Turn and lease behaviour | Every worker, on every platform |
| **Autoscaling enabled** | Let the adapter move capacity between min and max | ECS only |

## Who applies what, and when

- **The worker scheduler leader** (ADR-018, one worker at a time) owns scaling. The API never calls a
  platform API and holds no scaling permissions.
- The leader applies settings when it becomes leader, every 5 minutes (a reconcile that reads the
  platform and writes only what differs), and within seconds of a `config.changed` event for workers.
  On ECS it also publishes the scaling metrics every 60 seconds.
- Each attempt is recorded in `worker_scaling_state` with the latest `describe()` of the platform. The API
  serves it (both need `system.read`; `PATCH` needs `system.configure`):
  - `GET /v1/settings/workers`: the settings plus `scaling`, with `status` (`APPLIED`, `ADVISORY`, `FAILED`
    or `PENDING`), `message` (the reason when FAILED), `advisory` and `commands` (Compose), `changes`,
    `warnings`, `effective` values, `attemptedAt`, `appliedSettingsAt` and `inSync`.
  - `GET /v1/settings/workers/deployment`: the platform view the leader last recorded (on ECS: desired,
    running and pending tasks, scalable-target min and max, policy presence, alarm state). `describeError`
    says why a newer snapshot is missing.
- `PENDING` means the newest change has not been applied yet (`lastOutcome` still shows the previous
  result). If it stays PENDING for more than a few seconds, no worker is running or none holds leadership.
- **The fleet never scales to zero.** The leader is a worker, and it publishes the signals that would
  scale the fleet back out. A minimum of 0 is applied as 1, with a warning.

## Docker Compose (`DEPLOYMENT_DRIVER=compose`)

Replica count is operator-controlled, so every result is **ADVISORY**:

- `advisory` holds the exact command for the warm floor, for example
  `docker compose up -d --scale worker=2`. Run it on the host, or set `OCSO_WORKER_REPLICAS` in `.env` so
  the count survives the next `docker compose up -d`.
- Compose does **not** enforce max workers, target utilization, the queue-age and depth thresholds, the
  scale-in cooldown or the autoscaling switch (a warning says so when it is on).
- Raise replicas by hand, up to max workers, when the *queue age above threshold* alert fires.
- Keep `DATABASE_POOL_SIZE` × (api + workers) below PostgreSQL's `max_connections` (100 by default).
- No metrics are published and no task protection is needed: `docker compose restart worker` gives each
  worker 90 seconds to drain.

## ECS Fargate (`DEPLOYMENT_DRIVER=ecs`)

Terraform (`modules/autoscaling`) creates the scalable target, both policies and the queue-age alarm, and
ignores the attributes OCSO owns at runtime, so `terraform apply` never reverts them (ADR-022). The
adapter addresses **only these names**. It never lists, creates under other names, or deletes anything
else:

| Resource | Name |
|---|---|
| Scalable target | `service/<ECS_CLUSTER>/<ECS_WORKER_SERVICE>` (`ecs:service:DesiredCount`) |
| Target-tracking policy | `<ECS_CLUSTER>-worker-slot-demand` |
| Step-scaling policy | `<ECS_CLUSTER>-worker-queue-age` |
| Queue-age alarm | `<ECS_CLUSTER>-worker-queue-age-high` |

The cluster name equals Terraform's `<name>-<environment>` prefix. The `worker_scaling` Terraform output
lists the exact names.

**How the settings map (autoscaling on):**

| Setting | Maps to |
|---|---|
| **Min warm workers** / **Max workers** | `RegisterScalableTarget` MinCapacity / MaxCapacity (min at least 1) |
| **Conversations per worker** × **Target utilization** | Target-tracking `TargetValue` on the metric math `IF(workers > 0, demand / workers, demand)` over `SlotDemand` and `Workers` (both `Average`) |
| **Scale-in cooldown** | Target-tracking `ScaleInCooldown`. `ScaleOutCooldown` is fixed at 60 s. |
| **Scale out at queue age** | Alarm `Threshold`. The step policy adds 1 task at the threshold and 3 at threshold + 60 s (step cooldown 60 s). |
| **Scale out at queue depth** | No separate rule: queued turns are part of `SlotDemand`, so target tracking already scales on depth. |

- **Autoscaling off.** The service is pinned at min = max = warm floor. The policies and the alarm stay
  (Terraform owns their existence), and with min = max they cannot move capacity. Turning autoscaling back
  on restores the configured min and max.
- **Only real differences are written.** A target-tracking policy is re-put only when its configuration
  differs, because re-putting recreates its alarms and restarts their evaluation.
- **The alarm keeps Terraform's metric.** When the alarm exists (Terraform creates it on the SQS
  `ApproximateAgeOfOldestMessage` of the `conversation.turn` queue), OCSO changes only its threshold and adds
  the step policy to its actions if missing. Other actions, such as SNS, are kept. If the alarm is missing,
  OCSO creates it on its own `OldestQueueAgeSeconds` metric.
- **Settings changed outside OCSO are not reverted.** Suspended dynamic scaling or disabled alarm actions
  set by hand stay as they are and surface as `warnings`.

**Metrics** (`PutMetricData` every 60 s, namespace `OCSO_METRICS_NAMESPACE`, default `OCSO/<ECS_CLUSTER>`,
single dimension `Service=worker`, zeros published):

| Metric | Definition (PostgreSQL is the source) |
|---|---|
| `SlotDemand` | `TurnsInFlight` + ready `conversation.turn` wake-ups |
| `Workers` | Workers with status HEALTHY and a heartbeat no older than 3 × the heartbeat interval |
| `OldestQueueAgeSeconds` | Oldest ready turn wake-up. SQS cannot report age, so under SQS: the oldest unprocessed customer message in an AI-controlled conversation with no turn running |
| `TurnsInFlight` | Busy, unexpired conversation leases |
| `TurnLatencyP95` | p95 of `turns.latency_ms` completed in the last 5 minutes (omitted without data) |

**Scale-in protection.** Each worker turns on ECS task scale-in protection through
`$ECS_AGENT_URI/task-protection/v1/state` while it runs turns:

- It is reference-counted: on when the first turn starts, off when the last one ends.
- The expiry is 2 × turn timeout + 2 minutes, refreshed while turns keep running.
- Failures are logged at most once a minute and never affect a turn.
- Without `ECS_AGENT_URI` (outside a task), protection is off and a warning is logged.

**Worker environment:** `DEPLOYMENT_DRIVER=ecs`, `ECS_CLUSTER`, `ECS_WORKER_SERVICE`,
`OCSO_METRICS_NAMESPACE`, `AWS_REGION`, and `ECS_AGENT_URI` (set by ECS). The api gets the first three only
to pass shared configuration validation; its role cannot act on them.

**IAM (worker task role only; Terraform `modules/iam/scaling.tf`):**

| Permission | Scope |
|---|---|
| `application-autoscaling:RegisterScalableTarget`, `PutScalingPolicy`, `DeleteScalingPolicy` | The worker scalable target (`DeleteScalingPolicy` is not used today) |
| `application-autoscaling:Describe*` | `*` (read-only; no resource types) |
| `cloudwatch:PutMetricData` | Conditioned on the namespace |
| `cloudwatch:PutMetricAlarm`, `DeleteAlarms` | Alarms named `<ECS_CLUSTER>-worker-*` (`DeleteAlarms` is not used today) |
| `cloudwatch:DescribeAlarms` | `*` |
| `ecs:DescribeServices` | The worker service |
| `ecs:UpdateTaskProtection`, `GetTaskProtection` | The cluster's tasks |

Registering a scalable target needs the service-linked role
`AWSServiceRoleForApplicationAutoScaling_ECSService`. AWS creates it the first time Terraform registers the
target; if an SCP blocks that, create it once with
`aws iam create-service-linked-role --aws-service-name ecs.application-autoscaling.amazonaws.com`.

## Troubleshooting

| Symptom | Meaning and fix |
|---|---|
| `FAILED: No Application Auto Scaling target is registered …` | `deploy_services` is false or the target was deleted. Apply Terraform again; OCSO does not create targets. |
| `FAILED: … AccessDeniedException` | The worker task role lacks a permission above, or `ECS_CLUSTER` does not match the Terraform prefix (the alarm scope is name-based). |
| Target tracking stays `INSUFFICIENT_DATA` | No leader is publishing (look for `scheduled task failed` with `scaling-metrics` in the worker logs), or the namespace does not match the policy. |
| Status stays `PENDING` | No worker is running, or none holds leadership. Check the worker logs and **Platform → Workers**. |
| Deploys wait on old tasks | Protected tasks block replacement until their turns end. Terraform sets `deployment_maximum_percent = 200` so new tasks start alongside. |

## Limits and known gaps

- The ECS path has not run against a real AWS account, and the target-tracking metric math has not been
  checked with `aws cloudwatch get-metric-data` against real data (ADR-023).
- On Compose nothing enforces the maximum or autoscaling.

## Related

- [Deploy with Docker Compose](../guides/deploy/docker-compose.md#9-scale-workers)
- [Deploy on AWS](../guides/deploy/aws.md)
- [Resilience and load testing](resilience-testing.md)
- [Architecture](../concepts/architecture.md)
