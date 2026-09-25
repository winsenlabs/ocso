# Resilience and load testing

Two scripts in [tests/resilience/](../../tests/resilience/) run the real processes (the built api and
several built workers, against throwaway PostgreSQL databases) and drive them through the public web chat
API. The chaos script checks that a worker crash or drain loses and duplicates no customer reply; the load
script measures reply latency. For contributors changing the worker, queues or leases, and for operators
who want a baseline for their own deployment.

Both use the development-only scripted model (ADR-015) with a configurable latency, so they measure
OCSO's own overhead, not a model provider's.

## Prerequisites

- A checkout with dependencies installed ([Run from source](../guides/deploy/local-development.md)).
- A PostgreSQL 18 server whose user may create and drop databases and roles. The scripts connect to
  `RES_PG_URL`, default `postgres://localhost:5432`.
- `psql` on your `PATH`.
- The api, the worker and their dependencies built (this includes the migration bins):

  ```bash
  pnpm turbo run build --filter=@ocso/api... --filter=@ocso/worker...
  ```

## Run

```bash
export RES_PG_URL=postgres://postgres:postgres@localhost:5432   # if not the default

pnpm test:chaos                                        # worker crash + graceful drain
pnpm test:load --conversations 100 --messages 3 --workers 2
pnpm test:load --base-url https://support.meridian.example --key <web chat channel public key>
```

> [!NOTE]
> Pass the options straight after the script name. pnpm 11 forwards a literal `--` to the script, and the
> scripts' argument parser rejects it, so `pnpm test:load -- --conversations 100` fails. Running the file
> directly also works: `node tests/resilience/load-webchat.mjs --conversations 100`.

| Variable | Meaning |
|---|---|
| `RES_PG_URL` | PostgreSQL server for the throwaway databases (default `postgres://localhost:5432`) |
| `RES_DB_POOL` | `DATABASE_POOL_SIZE` for the api and workers (default 10) |

Each local run creates a main database (`ocso_chaos` or `ocso_load`), an audit database `<name>_audit`
with its own writer role provisioned by `audit-migrate`, a temporary blob directory and a temporary audit
signing key, then drops them all at the end. The api listens on port 4490 (chaos) or 4495 (load) and the
workers' health servers on the ports just above. The stack sets `OCSO_DEV_SKIP_ACCESS_APPROVAL=true` and
lifts the per-address web chat rate limits, because every simulated visitor comes from one address.

## Chaos: `chaos-worker-kill.mjs`

Options: `--conversations` (default 20) and `--latency` (model latency in ms, default 3000).

1. **Crash.** Two workers. Every customer sends a message; while the turns are running, `worker-0` is
   killed with `SIGKILL`.
2. **Drain.** A replacement worker starts, and `worker-1` gets `SIGTERM` while new turns are in flight. It
   must stop cleanly (exit 0 or by `SIGTERM`).

**Pass criteria:** every customer message gets **exactly one** AI reply, with no loss and no duplicates.
The script prints `chaos: PASS` or `chaos: FAIL — <reason>` and exits non-zero on failure.

What recovery relies on (ADR-008): conversation leases with a fencing version; the leader marks a worker
LOST after three missed heartbeats (heartbeat interval × 3, at least 15 s), deletes its leases and
returns its running queue jobs at once; the stranded-turn sweeper re-enqueues anything else. On SQS, a
dead worker's messages come back after their visibility timeout (turn timeout + 30 s). The script sets a
3 s heartbeat, a 10 s lease and a 20 s turn timeout.

Last recorded local run (Apple silicon laptop with other work running):

| Scenario | Conversations | All answered in | Duplicate replies |
|---|---|---|---|
| Crash (`SIGKILL` mid-turn) | 20 | 20.3 s | 0 |
| Drain (`SIGTERM`, replacement started) | 20 | 10.5 s | 0 |

## Load: `load-webchat.mjs`

Options: `--conversations` (default 50), `--messages` per conversation (3), `--workers` (2), `--latency`
(model latency in ms, 800), `--per-worker` (conversations per worker, 25), `--reply-timeout` (seconds, 60),
and `--base-url` with `--key` to run against an existing deployment instead of a local stack.

N customers each send M messages and wait for the reply (send → reply visible in the web chat history,
polled every 300 ms, so the figures include up to 0.3 s of polling). The report separates the first message
of a conversation (new conversation, cold context) from follow-ups and, for local runs, reads the `turns`
table to show how long turns waited for a worker and how long they ran.

Last recorded local run: 60 conversations × 3 messages, 2 workers × 40 slots, 800 ms model latency. 180/180
replies, 0 errors, 0 duplicates; reply p50 2.5 s, p95 7.2 s; turn run time p50 1.5 s (model 0.8 s +
streaming + persistence).

> [!WARNING]
> Against a real deployment (`--base-url`), the load script sends real web chat traffic through whatever
> router and model profile that channel uses, and model calls cost money. Use a staging deployment and a
> dedicated channel. The deployment's per-address web chat rate limits still apply, so raise
> `OCSO_WEBCHAT_RATE_LIMITS` there for the test or expect `429 rate_limited`.

Numbers from a shared laptop are noisy. Use them to catch regressions, not for capacity planning; for
that, run the load script against staging with the real model profile.

## Findings these tests produced

- Lost workers' queue jobs are released at once (they used to wait for the visibility timeout, 129 s in
  the first run).
- A turn-timeout change re-subscribes the turn consumer (the visibility timeout was fixed at start-up).
- A worker already draining a conversation no longer re-acquires its own lease for the next message's
  job. That fenced the running turn and wasted a model call; fenced turns are now recorded as SUPERSEDED.

## Limits and known gaps

- The scripts run only on one machine with the `postgres` queue driver. SQS redelivery is described above
  but not exercised by them.
- The recorded numbers are from one laptop run, not a benchmark.

## Related

- [Worker scaling](worker-scaling.md)
- [Run from source](../guides/deploy/local-development.md)
- [Architecture](../concepts/architecture.md)
- [CONTRIBUTING: tests](../../CONTRIBUTING.md#tests)
