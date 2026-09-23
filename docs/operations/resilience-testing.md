# Resilience and load testing

Two scripts exercise the real processes (built API + workers, throwaway PostgreSQL database) through the
public web chat API. Build first:

```bash
npx turbo run build --filter=@ocso/api... --filter=@ocso/worker...
pnpm test:chaos                                  # worker crash + graceful drain
pnpm test:load -- --conversations 100 --messages 3 --workers 2
pnpm test:load -- --base-url https://support.example.com --key <web chat channel key>   # any deployment
```

Both use the development-only scripted model (ADR-015) with a configurable latency, so they measure
OCSO's own overhead, not a model provider's. Set `RES_PG_URL` to use another PostgreSQL server and
`RES_DB_POOL` to change `DATABASE_POOL_SIZE`.

## Chaos: `tests/resilience/chaos-worker-kill.mjs`

1. **Crash.** Two workers; 20 customers send a message; while the turns are running (3 s model latency),
   one worker is killed with `SIGKILL`.
2. **Drain.** A replacement worker starts; the remaining original worker gets `SIGTERM` while new turns
   are in flight.

Pass criteria: every customer message gets **exactly one** AI reply (no loss, no duplicates).

What recovery relies on (docs/10 §9, ADR-008): conversation leases with a fencing version; the leader
marks a worker LOST after three missed heartbeats (`heartbeatIntervalSeconds` × 3, at least 15 s),
deletes its leases and returns its running Postgres-queue jobs to the queue at once; the stranded-turn
sweeper re-enqueues anything else. On SQS, a dead worker's messages come back after their visibility
timeout (`turnTimeoutSeconds` + 30 s).

Last local run (Apple silicon laptop, other workloads running, 3 s heartbeat, 10 s lease):

| Scenario | Conversations | All answered in | Duplicate replies |
|---|---|---|---|
| Crash (SIGKILL mid-turn) | 20 | 20.3 s | 0 |
| Drain (SIGTERM, replacement started) | 20 | 10.5 s | 0 |

Before the reaper released lost workers' jobs, crash recovery waited for the 120 s visibility timeout
(129 s in the first run).

## Load: `tests/resilience/load-webchat.mjs`

N customers each send M messages and wait for the reply (send → reply visible in the web chat history,
polled every 300 ms, so the figures include up to 0.3 s of polling). The report splits the first message
of a conversation (new conversation, cold context) from follow-ups and, for local runs, shows from the
`turns` table how long turns waited for a worker and how long they ran.

Last local run: 60 conversations × 3 messages, 2 workers × 40 slots, 800 ms model latency — 180/180
replies, 0 errors, 0 duplicates; reply p50 2.5 s, p95 7.2 s; turn run time p50 1.5 s (model 0.8 s +
streaming + persistence). Numbers on a shared laptop are noisy; use them for regressions, not capacity
planning. For capacity planning run the load script against a staging deployment with the real model
profile.

## Findings fixed by these tests

- Lost workers' queue jobs are released immediately (was: after the visibility timeout).
- A turn-timeout change now re-subscribes the turn consumer (the visibility timeout was fixed at start-up).
- A worker already draining a conversation no longer re-acquires its own lease for the next message's
  job (that fenced the running turn and wasted a model call); fenced turns are recorded as SUPERSEDED.
