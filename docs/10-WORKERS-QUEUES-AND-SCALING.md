# Workers, Queues and Scaling

## 1. Core idea

A queue item is not equivalent to "one message equals one isolated process."

OCSO should keep active conversations warm where useful while preserving durable recovery.

A worker may own multiple active conversations concurrently, for example 10, but this is configurable and must be benchmarked.

## 2. Conversation leases

Use a lease/ownership record:
- conversation_id
- worker_id
- lease_version
- acquired_at
- expires_at
- heartbeat

New work for an active conversation should preferentially route to the worker holding the valid lease.

If a worker dies, lease expiry allows another worker to recover from PostgreSQL.

## 3. Serialization

Only one customer-facing agent execution should be active for a conversation unless the runtime has an explicit concurrency-safe design.

Prevent duplicate replies with:
- conversation leases
- turn versioning
- idempotency keys
- transactional state transitions

## 4. Queue abstraction

Provide an OCSO queue interface.

Implementations may include:
- a simple local/Postgres/Redis-backed mode for Compose
- SQS for AWS/Fargate production

Do not make business code depend directly on SQS APIs.

## 5. Worker configuration

Tech Admin can configure:
- minimum warm workers
- maximum workers
- nominal conversations per worker
- provider/API concurrency limits
- queue thresholds
- scale-out target
- scale-in cooldown
- turn timeout
- lease duration/heartbeat

Settings must have safe defaults and validation.

## 6. ECS scaling signals

Useful signals:
- queue age/depth
- active conversation slots
- worker utilization
- model requests in flight
- observed response latency
- CPU/memory as secondary infrastructure signals

Do not scale solely on CPU.

## 7. Low-latency goal

The architecture should minimize:
- container cold start
- unnecessary queue round trips
- repeated context reconstruction
- unnecessary tool discovery
- repeated authentication refresh
- provider connection setup

Keep a small warm worker floor in production.

## 8. Backpressure

When capacity is exhausted:
- accept/persist inbound customer interaction safely
- expose queue/wait status internally
- scale if permitted
- apply provider-specific concurrency controls
- avoid overload cascades

## 9. Recovery

A replacement worker can reconstruct execution from:
- persisted interactions
- current conversation state
- active prompt/version
- tool-call records
- derived summary/cache if valid

No sticky machine may be required for correctness.
