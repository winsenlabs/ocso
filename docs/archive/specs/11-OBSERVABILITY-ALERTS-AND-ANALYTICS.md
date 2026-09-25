# Observability, Alerts and Analytics

> [!IMPORTANT]
> **Original design spec (2026-09): parts are superseded; see [alerts-and-webhooks.md](../../guides/alerts-and-webhooks.md), [governance.md](../../concepts/governance.md).** This page is kept for history. Where it and the code disagree, the code and [PM/ARCHITECTURE-DECISIONS.md](../../../PM/ARCHITECTURE-DECISIONS.md) win. Links inside it may point to pages that have since moved.

## 1. Principle

Observability is user-type specific. Do not build one giant dashboard that mixes infrastructure and business metrics.

## 2. Tech view

Technical telemetry:
- service uptime
- API/worker health
- worker count/capacity
- active conversation leases
- queue depth and age
- CPU/memory/network
- model request rate
- time to first token
- end-to-end turn latency
- provider/model error rate
- input/output/reasoning tokens
- prompt-cache reads/writes/hit ratios
- model/provider cost metadata
- MCP/tool connection health
- tool latency/failure
- retries/timeouts
- webhook health
- database health
- traces/logs
- deploy/version metadata

## 3. Head and Lead view

Business/agent telemetry:
- conversations by type/channel
- AI containment
- human escalation
- resolution
- first response time
- time to resolution
- SLA breaches
- escalation reasons
- repeated failure topics
- prompt correction candidates
- knowledge/tool gaps
- CSAT or configured satisfaction signal
- sales outcomes/conversion where relevant
- follow-up outcomes
- agent-by-agent trends
- queue/team performance

Avoid claiming a universal "agent quality score" unless its method is explicit and auditable.

## 4. Service view

Operational attention:
- assigned conversations
- pickup queue
- waiting time
- priority
- customer replies
- SLA risk
- handoff requests
- workload

## 5. OpenTelemetry

Instrument the application with OpenTelemetry-compatible traces/metrics/log correlation where practical.

At minimum correlate:
- request
- conversation
- turn
- model request
- tool call
- worker
- alert

Never put secrets/raw credentials in telemetry.

## 6. Alerts

Alerts are first-class entities.

Pipeline:
```
Event/metric
  -> Alert rule
  -> Deduplication/window
  -> Severity
  -> Audience
  -> Delivery
  -> Ack/resolution
```

### Technical examples
- healthy workers below minimum
- queue age too high
- provider failure spike
- MCP server unavailable
- database degraded
- auth failures
- token/cost anomaly
- monthly model spend reaching a budget threshold (`spend_budget_above`, ADR-027): month-to-date spend in the deployment timezone against a USD budget, once per threshold per month, with a month-end projection
- latency SLO breach

### Business examples
- escalation rate spike
- SLA breach
- unusual unresolved volume
- repeated failure intent
- agent response-quality issue
- tool/business action failures
- conversion/outcome anomaly

Alert rules are maker–checker objects (PM/research/11 §4; ADR-030 amendment): two approval kinds over one table —
`alert_rule` (business: made with `alert_rules.business.manage`, checked with `approvals.check.agents`) and
`alert_rule_technical` (`alert_rules.technical.manage`, checked with `approvals.check.platform`). A new rule is a
**disabled draft**, edited directly; turning it on (and back on) is an ACTIVATE proposal; once approved, every change is
an UPDATE proposal and the kind is fixed; deleting is always a proposal, finished by the worker (the rule's open alerts
resolve and their destinations get RESOLVED). Turning a rule off is immediate, even while a proposal waits. The default
rules setup installs are recorded as installed configuration (an APPROVED `MIGRATION`-origin row, like the grandfather
migration), so they are never "live without approval".

## 7. Alert delivery

Support pluggable:
- in-app
- email
- Slack/Teams
- webhook
- pager/on-call integration

## 8. Internal OCSO agent

Alerts and observability must be queryable by the internal agent subject to the logged-in user's permissions.

## 9. Exceptions: the weekly control report

The exception report (PM/research/11 §7, ADR-033) lists everything that went *around* or *wrong* in the
controls. It is not a dashboard: every item is something an auditor would ask about.

**Checks** (`EXCEPTION_KINDS`, `packages/application/src/exceptions/`), each with a severity and one sentence saying
what it looks at:

| Check | What it finds |
|---|---|
| `live_without_approval` (critical) | For every registered approvable kind, its descriptor's `liveObjects()` without an *applied* approval that puts the object live: an `APPROVED` CREATE, UPDATE or ACTIVATE with `activated_at` set (an approved DELETE, or one still activating, does not count; `MIGRATION` records do). The approval registry is walked, never a list of kinds. `permission_change` is left to `permission_bypass`. State as of generation. |
| `permission_bypass` (critical) | Active GRANTs whose proposal is missing or not `APPROVED`; and, from the audit trail, every access increase or sign-in enablement in the period (`user.permissions_increased` on an active user, `user.activate`, `user.enable`) that no approval applied (`after.proposalId` empty), plus events marked `approvalSkipped` (`dev_flag`, `demo_seed`). |
| `changed_outside_approval` (high) | From the audit trail: writes by a person in the period to an object of a registered kind that already had an applied approval, or that took it live (`<kind>.activate`, `.go_live`, `.enable`), which were not part of applying an approval (no approval decision shares their correlation id). Stop actions and operational events (pause, disable, delete, removals, reductions, tests, invites, OAuth, provider status, inert drafts) are exempt by verb. |
| `audit_chain` (critical) | `CHAIN_BROKEN` / `SIGNING_KEY_CHANGED` incidents that overlapped the period; full-chain verifications in it that found problems. |
| `audit_shipping` (high) | Shipping incidents (`SHIP_FAILED`, `STORE_DOWN`, `RECONCILE_MISSING`, `EXPORT_FAILED`) that overlapped the period, and the current shipping lag when above 60 s. |
| `bootstrap_approvals` (high) | `BOOTSTRAP_APPROVE` decisions in the period (a maker approving their own change because nobody else anywhere could). |
| `resubmitted_unchanged` (high) | Proposals submitted in the period with exactly the payload and resulting configuration of an earlier rejected one for the same object. |
| `approvals_aged` (medium) | Open proposals older than `approval_age_warning_hours`; proposals decided in the period after waiting longer; approvals still activating an hour after the decision. |
| `delivery_failures` (medium) | Failed customer messages (per channel and error), webhook deliveries and alert notifications in the period. Errors keep their first line only. |
| `routing_fallback` (medium) | From the conversation timeline (`system.routed`): conversations a router sent to its fallback queue or timed out on, per router and queue; routing that could not place a customer; customer messages refused because no router was active. |
| `templates_rejected` (low) | Live: templates currently rejected. Report: every rejection audited in the period (`message_template.status_changed`), even if fixed or deleted since. |
| `report_hygiene` (medium) | No weekly report within 30 h of a week ending, weekly reports unsigned 7 days after it, unsigned reports whose checks failed. |
| `installed_only` (low) | Per kind, live objects whose only approval is a `MIGRATION` record (0031, or installed at setup). Informational. |

A check that fails is recorded in its section with its error *class* (`db_error:<sqlstate>`, `timeout`,
`check_failed`; the full error goes to the server log only). All checks run in one `REPEATABLE READ` read-only
snapshot, each in its own savepoint; descriptor calls inside a check run in their own savepoints too, and an item
whose owning teams cannot be read is restricted to signers. A report lists up to 5,000 items per check (the live
view 500) and keeps the true total and per-audience counts, so scoped totals stay exact. Checks that read event
history record where that history starts (`coverage.dataFrom`: audit local window, conversation and operational
retention); a period that starts earlier is marked incomplete.

**Live view and weekly reports.** `/exceptions` shows the live view: every check computed on read, events over the
last seven days, state as of now. The `exception-weekly` leader task (every minute; two reads when there is nothing
to do) generates nothing before setup is complete. The first report covers the last complete Monday-to-Monday week
in the deployment's time zone; each later one starts where the previous one ended and ends at the first local
Monday 00:00 at least a day later. Missed weeks are back-filled oldest first (8 per run), and a time-zone change
makes one shorter or longer bridging period. An exclusion constraint forbids overlapping weekly reports. Each report
is audited (`exception_report.generate`) and announced by `exception_report.ready` (no item count: it reaches
scoped readers). A signer can also freeze an ad-hoc report (at most 31 days, within the last 90) and **regenerate**
an unsigned report (`POST …/:id/regenerate {reason}`): the draft becomes `SUPERSEDED`, pointing at its successor.

**Who sees what.** `exceptions.read` (Head, Tech) sees platform-wide items, items of their teams, and items about a
person's access (`readableWith: users.read`) whatever the person's teams. `exceptions.sign` (Head) sees the whole
report, signs it and exports it. A scoped reader never receives the signature or the export.

**Signing.** The content hash is `sha256(canonicalJson(content))` (hex); the content includes the report's kind. The
signer sends the hash they were shown and acknowledges every **attestation** flag that applies to them:
`self_attested` (they act or are the subject of a critical/high item, or their own access was bootstrap-approved),
`failed_checks`, `truncated`, `incomplete_data` — otherwise 409 `attestation_required`. The signature is Ed25519 with
the audit signing key over the spec's six lines plus two:
`ocso-exception-report\n<id>\n<start>/<end>\n<content_hash>\n<signer id>\n<signed_at>\nattestation:<flags|none>\nnote-sha256:<hex|none>`.
The public key is stored with the report, so it stays verifiable and exportable after key rotation; the screen shows
whether that key is the server's current, a retired or an unknown key. Without a key the screen says so. Signing is
audited. The trigger rejects DELETE/TRUNCATE, any UPDATE of a signed or superseded report, and any UPDATE of a draft
other than signing or superseding it.

**Export** (`GET /v1/exceptions/reports/:id/export`, signed reports only, audited): a zip with `report.json`,
`items.csv`, `manifest.json` (incl. `attestation`, `signNote`, `noteSha256`, `keyTrust`), `signed-message.txt`,
`signature.bin`, `public-key.pem` and `VERIFY.txt`:

```
sha256sum report.json                                      # = contentHash in manifest.json
openssl pkeyutl -verify -pubin -inkey public-key.pem -rawin -in signed-message.txt -sigfile signature.bin
openssl pkey -pubin -in public-key.pem -outform DER | sha256sum | cut -c1-16   # = keyId
```

Compare `public-key.pem` with the key pinned from the deployment (`GET /v1/audit/keys`): a bundle can carry any key.

API: `GET /v1/exceptions/live`, `GET /v1/exceptions/reports`, `GET /v1/exceptions/reports/:id` (`exceptions.read`);
`POST /v1/exceptions/reports`, `POST /v1/exceptions/reports/:id/sign {contentHash, note?, acknowledge?}`,
`POST /v1/exceptions/reports/:id/regenerate {reason}`, `GET /v1/exceptions/reports/:id/export` (`exceptions.sign`).

## 10. Storage growth and health history

**Storage samples.** The `storage-sample` leader task (hourly; one row per table and UTC day, re-runs overwrite the
day) records every main-database table's rows (exact below 64 MB, the planner's estimate above) and bytes (with
indexes and TOAST), and the audit store's record count and size (`audit_store.audit_records`). Samples are kept 400
days. `GET /v1/system/storage` (`system.read`) returns each table's size and growth over 7 and 30 days, the database
total per day (90 days), the audit store, and the audit store guidance; the System screen shows it as the Storage panel.

**Audit store guidance.** Thresholds (`AUDIT_STORE_GUIDANCE`): *consider* a columnar audit store at 50 M records,
50 GiB or 500 k events a day (or when the current rate reaches the *recommend* line within 180 days); *recommend* it
at 250 M records, 250 GiB or 2 M events a day. The store declares its own sizing profile (`AuditStore.sizing`:
`row` for the postgres driver, `columnar` for ClickHouse); core never compares driver names. Moving is an operator
decision, never automatic: provisioning is in docs/operations/compose.md ("ClickHouse instead"). OCSO does not copy
existing audit records between stores; keep the old store (read-only) for its retention.

**Health roll-ups.** The `health-rollup` leader task (every 5 min) rolls each complete hour of `health_samples` into
`health_sample_rollups`: per component (samples, OK/DEGRADED/DOWN, minutes, minutes without DOWN, latency avg/p95/max)
and one `availability` row with the per-minute uptime verdict of that hour (the same rule as the 30-day uptime).
Raw samples are then kept 48 hours (whole hours only, and only once rolled up); roll-ups a year. 30-day uptime
adds the roll-ups of hours before the first raw sample to the raw minutes, so the figure is unchanged by the prune. Operational retention never deletes raw samples newer than the last rolled-up hour, so a lagging roll-up cannot turn pruned hours into false downtime.
Readers that look at recent windows (status bar, the database-degraded alert) keep reading raw samples; an alert
window longer than 48 hours sees only the last 48.
