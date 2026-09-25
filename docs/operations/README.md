# Operations runbooks

Runbooks for the people who keep an OCSO deployment running: backups, upgrades, scaling, testing
resilience and fixing common failures. They assume you have already installed OCSO with
[Docker Compose](../guides/deploy/docker-compose.md) or on [AWS](../guides/deploy/aws.md) and completed
[first-run setup](../guides/first-run-setup.md).

![The System screen: health tiles, worker fleet, audit store and recent privileged changes](../assets/screens/system.webp)

| Runbook | Use it when |
|---|---|
| [Backups and restore](backups-and-restore.md) | Setting up backups, restoring after data loss, protecting the master key and the audit signing key |
| [Upgrades](upgrades.md) | Moving to a new release: migrations, the audit store step, pinning versions, rolling back |
| [Worker scaling](worker-scaling.md) | Changing worker capacity, and how the settings map onto Compose and ECS autoscaling |
| [Resilience and load testing](resilience-testing.md) | Checking that a worker crash or drain loses no customer message, and measuring reply latency |
| [Troubleshooting](troubleshooting.md) | Something fails: start-up errors, migrations, audit store incidents, channel webhooks, sign-in, routing |

## Where to look first

- **Platform → System** (Tech): health of providers, MCP servers and workers, the **Audit store** panel
  (shipping, sealing, checkpoints, exports, incidents), storage growth and installed plugins.
- **Platform → Workers** and **Platform → Queues & leases**: the worker fleet, the scaling status and
  conversation leases.
- **Exceptions** (Tech and Head): controls that were bypassed or failed, including audit incidents and
  bootstrap approvals.
- Logs: every process writes JSON (pino) to stdout. Compose: `docker compose logs -f api worker`. AWS:
  CloudWatch log groups `/ecs/<prefix>-<service>`.
- Health endpoints: api `/health/live`, `/health/ready`, `/health/dependencies` (needs `system.read`);
  worker `/health/live`, `/health/ready` on port 4100; web `/login`.

## Related

- [Deploy with Docker Compose](../guides/deploy/docker-compose.md)
- [Deploy on AWS](../guides/deploy/aws.md)
- [Audit](../concepts/audit.md)
- [Architecture](../concepts/architecture.md)
- [Configuration reference](../reference/configuration.md)
