# Worker scaling: Compose vs ECS

The Tech Admin sets worker capacity in OCSO (System → worker configuration, `PATCH /v1/settings/workers`,
docs/10 §5). A **deployment adapter** in the worker maps those logical settings onto whatever the
platform can enforce (docs/13 §4, ADR-023). The product code is identical on both platforms. Only
`DEPLOYMENT_DRIVER` differs.

## Who applies what, and when

- **The worker scheduler leader** (ADR-018, one worker at a time) owns scaling. The API never calls a
  platform API and needs no scaling permissions.
- The leader applies settings:
  - when it becomes leader;
  - every 5 minutes (a reconcile: it reads the current platform state and writes only what differs);
  - within seconds of a `config.changed` event for `workers`.
- On ECS it also publishes the scaling metrics every 60 s.
- Each attempt is recorded in `worker_scaling_state` together with the latest `describe()` of the platform.
  The API serves that record:
  - `GET /v1/settings/workers` returns the settings plus `scaling`:
    - `status`: `APPLIED`, `ADVISORY`, `FAILED` or `PENDING`
    - `message` (the reason, when FAILED)
    - `advisory` and `commands` (Compose)
    - `changes`, `warnings` and `effective` values
    - `attemptedAt`, `appliedSettingsAt` and `inSync`
  - `GET /v1/settings/workers/deployment` returns the platform view the leader last recorded (on ECS:
    desired, running and pending tasks, scalable-target min/max, policy presence, alarm state).
    `describeError` says why a newer snapshot is missing.
  - Both need `system.read`. `PATCH` needs `system.configure`.
- `PENDING` means the newest change has not been applied yet (`lastOutcome` still shows the previous
  result). If it stays PENDING for more than a few seconds, no worker is running or none holds leadership.
- Some settings are enforced by every worker on every platform, independent of the adapter: conversations
  per worker (turn concurrency), turn timeout, lease duration, heartbeat and idle lease.
- **The fleet never scales to zero.** The leader is a worker, and it publishes the signals that would scale
  the fleet back out. A minimum of 0 is therefore applied as 1, and the result carries a warning saying so.

## Docker Compose (`DEPLOYMENT_DRIVER=compose`)

Replica count is operator-controlled, so every result is **ADVISORY**:

- `advisory` holds the exact command for the warm floor, for example `docker compose up -d --scale worker=2`.
  Run it on the host.
- Compose does **not** enforce:
  - max workers
  - target utilization
  - queue-age/depth thresholds
  - scale-in cooldown
  - the autoscaling switch (a warning says so when it is on)
- Raise replicas by hand, up to max workers, when the *queue age above threshold* alert fires.
- No metrics are published and no task protection is needed: `docker compose restart worker` already gives
  90 s to drain (compose.md §3).

## ECS Fargate (`DEPLOYMENT_DRIVER=ecs`)

Terraform (`modules/autoscaling`) creates the scalable target, both policies and the queue-age alarm. It
ignores the attributes OCSO owns at runtime, so `terraform apply` never reverts them (ADR-022). The
adapter addresses **only these names**. It never lists, creates under other names, or deletes anything
else:

| Resource | Name |
|---|---|
| Scalable target | `service/<ECS_CLUSTER>/<ECS_WORKER_SERVICE>` (`ecs:service:DesiredCount`) |
| Target-tracking policy | `<ECS_CLUSTER>-worker-slot-demand` |
| Step-scaling policy | `<ECS_CLUSTER>-worker-queue-age` |
| Queue-age alarm | `<ECS_CLUSTER>-worker-queue-age-high` |

The cluster name equals Terraform's `<name>-<env>` prefix. The `worker_scaling` Terraform output lists
the exact names.

**Settings → AWS (autoscaling on):**

| Setting | Maps to |
|---|---|
| min warm workers / max workers | `RegisterScalableTarget` MinCapacity / MaxCapacity (min at least 1) |
| conversations per worker × target utilization | Target-tracking `TargetValue` on metric math `IF(workers > 0, demand / workers, demand)` over `SlotDemand` and `Workers` (both `Average`) |
| scale-in cooldown | Target-tracking `ScaleInCooldown`. `ScaleOutCooldown` is fixed at 60 s |
| scale-out queue age | Alarm `Threshold`. The step policy adds +1 task at the threshold and +3 at threshold + 60 s (step cooldown 60 s) |
| scale-out queue depth | No separate rule: queued turns are part of `SlotDemand`, so target tracking already scales on depth |

- **Autoscaling off.** The service is pinned: min = max = warm floor. The policies and the alarm are
  left in place. Terraform owns their existence and would recreate deleted ones, and with min = max
  they cannot move capacity. Turning autoscaling back on restores the configured min/max.
- **Only real differences are written.** A target-tracking policy is re-put only when its configuration
  differs, because re-putting recreates its alarms and restarts their evaluation.
- **The alarm keeps Terraform's metric.** When the alarm exists (Terraform creates it on the SQS
  `ApproximateAgeOfOldestMessage` of the `conversation.turn` queue), OCSO changes only its threshold and
  adds the step policy to its actions if that is missing. Any other actions, such as SNS, are kept. If the
  alarm is missing, OCSO creates it on its own `OldestQueueAgeSeconds` metric instead.
- **Settings changed outside OCSO are not reverted.** Dynamic-scaling suspension or disabled alarm actions
  that someone set by hand stay as they are, and they surface as `warnings`.

**Metrics** (`PutMetricData` every 60 s, namespace `OCSO_METRICS_NAMESPACE`, default `OCSO/<ECS_CLUSTER>`,
single dimension `Service=worker`, zeros published):

| Metric | Definition (PostgreSQL truth) |
|---|---|
| `SlotDemand` | `TurnsInFlight` + ready `conversation.turn` wake-ups (queue stats) |
| `Workers` | Workers with status HEALTHY and a heartbeat ≤ 3 × heartbeat interval old |
| `OldestQueueAgeSeconds` | Oldest ready turn wake-up. SQS stats cannot report age, so under SQS: the oldest unprocessed customer message in an AI-controlled conversation with no turn running |
| `TurnsInFlight` | Busy, unexpired conversation leases |
| `TurnLatencyP95` | p95 of `turns.latency_ms` completed in the last 5 min (omitted without data) |

**Scale-in protection.** Each worker enables ECS task scale-in protection through
`$ECS_AGENT_URI/task-protection/v1/state`:

- It is reference-counted: on when the first turn starts, off when the last one ends.
- The expiry is 2 × turn timeout + 2 min, and it is refreshed while turns keep running.
- Failures are logged at most once a minute and never affect a turn.
- Without `ECS_AGENT_URI` (outside a task), protection is off and a warning is logged.

**Environment (worker):**
- `DEPLOYMENT_DRIVER=ecs`
- `ECS_CLUSTER`
- `ECS_WORKER_SERVICE`
- `OCSO_METRICS_NAMESPACE`
- `AWS_REGION`
- `ECS_AGENT_URI` (set by ECS)

The API gets the first three only to pass config validation.

**IAM (worker task role only; Terraform `modules/iam/scaling.tf`, aws.md §7):**
- `application-autoscaling:RegisterScalableTarget`, `PutScalingPolicy` and `DeleteScalingPolicy` on the
  worker scalable target. `DeleteScalingPolicy` is not used today.
- `application-autoscaling:Describe*` on `*`.
- `cloudwatch:PutMetricData`, conditioned on the namespace.
- `cloudwatch:PutMetricAlarm` and `DeleteAlarms` on `<ECS_CLUSTER>-worker-*`. `DeleteAlarms` is not used
  today.
- `cloudwatch:DescribeAlarms` on `*`.
- `ecs:DescribeServices` on the worker service.
- `ecs:UpdateTaskProtection` and `GetTaskProtection` on the cluster's tasks.

## Troubleshooting

| Symptom | Meaning / fix |
|---|---|
| `FAILED: No Application Auto Scaling target is registered …` | `deploy_services` is false or the target was deleted. Re-run Terraform. OCSO does not create targets |
| `FAILED: … AccessDeniedException` | The worker task role lacks one of the permissions above, or `ECS_CLUSTER` does not match the Terraform prefix (the IAM alarm scope is name-based) |
| Target tracking stays `INSUFFICIENT_DATA` | No leader is publishing (check the worker logs for `scheduled task failed` with `scaling-metrics`), or the namespace does not match the policy. Validate the expression with `aws cloudwatch get-metric-data` before relying on it (ADR-023) |
| Deploys wait on old tasks | Protected tasks block replacement until their turns end (≤ expiry). Terraform sets `deployment_maximum_percent = 200` so new tasks start alongside |
