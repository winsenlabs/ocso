# Scheduled tasks

Periodic work runs in the worker processes. Exactly one worker at a time, the scheduler leader, runs
the tasks; the others stand by (ADR-018). Scaling workers up or down, or losing the leader, never
double-runs or stops the schedule.

Examples of what runs today: sweeping stranded turns, reaping lost workers and expired leases,
auto-assignment and offer expiry, repairing stuck escalations, expiring tool confirmations, relaying
delayed jobs, health samples, requesting conversation insights, data retention, MCP health checks,
alert evaluation and delivery re-dispatch, retiring signing keys, relaying outbound webhooks, and worker
scaling reconciliation.

## The contract

`apps/worker/src/scheduler/scheduler.service.ts`:

```ts
export interface ScheduledTask {
  name: string;
  everySeconds: number;
  run(ctx: { db: Db; queue: QueueAdapter; correlationId: string }): Promise<unknown>;
}
```

## How one is registered

There are two lists:

- the core schedule, the `this.tasks` array in the `SchedulerService` constructor
  (`apps/worker/src/scheduler/scheduler.service.ts`);
- tasks contributed by subsystems (MCP, alerts, signing keys, webhooks, scaling), returned by
  `subsystemTasks()` in `apps/worker/src/scheduler/tasks.registry.ts`.

Add a subsystem's task to `subsystemTasks()`, which keeps the core schedule small:

```ts
{ name: 'acme-sync', everySeconds: 300, run: () => acmeService.syncDue() },
```

A task whose dependencies are not in `SubsystemDeps` needs them added there and passed in by
`SchedulerService`.

## What the core does for you

- **Leadership.** `LeaderElection` (`apps/worker/src/scheduler/leader.ts`) holds a session-level
  PostgreSQL advisory lock on a dedicated connection. If the leader process or its connection dies,
  PostgreSQL releases the lock and another worker takes over.
- **Timing.** A one-second tick runs each task when its `everySeconds` has elapsed. Ticks never overlap.
- **Isolation.** Each run gets a fresh `correlationId`. A task that throws is logged with its name and
  does not stop the others.

## Rules for a task

- **Idempotent.** Leadership can change mid-interval, so a task may run twice in a row on different
  workers. Every task must tolerate that.
- **Bounded.** Process a limited batch per run (the sweepers take `limit` arguments) and let the next
  tick continue.
- **Durable state in PostgreSQL.** A task keeps no in-memory state it relies on across runs.
- **Hand long work to the queue.** Publish jobs rather than doing slow external calls on the tick.

## Tests to copy

There are no tests of the scheduler itself in `apps/worker`. Test the function a task calls, the way
`packages/agent-runtime/test/reaper.int.test.ts` tests lease recovery and
`packages/application/test/retention.int.test.ts` tests retention, against real PostgreSQL.

## Limits today

- Registration is by editing the two lists above; there is no registry object.
- Intervals are fixed in code, not configurable per deployment.
