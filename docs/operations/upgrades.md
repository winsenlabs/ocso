# Upgrades

How to move an OCSO deployment to a newer version: pinning what you run, the two migration steps, the
order of operations on Docker Compose and AWS, and how to roll back. For operators.

> [!NOTE]
> OCSO has no tagged releases and no published container images yet. You build the images from a commit
> of `main` and pin that commit. CI builds every image target on each pull request but does not push them.

## How migrations work

- The schema lives in hand-written SQL files under `packages/db/migrations/` (ADR-004), applied by
  OCSO's own runner. It takes a PostgreSQL advisory lock, applies each file in its own transaction,
  records a checksum of every file it applied, and **refuses to run if an applied file was edited**.
  There are no down-migrations.
- Migrations run only in an explicit step: the Compose `migrate` one-shot service, or the ECS migrate task.
  The api and worker never migrate on start-up.
- The `migrate` image runs two commands in order:
  1. `node dist/bin/migrate.js`: the main database.
  2. `node audit-store/dist/bin/audit-migrate.js`: the audit store. It creates the audit database if it
     is missing, applies the audit schema (also checksummed), creates or updates the writer and reader
     roles (`ocso_audit_writer`, `ocso_audit_reader` on Compose and AWS) and sets the minimum retention
     (`AUDIT_MIN_RETENTION_DAYS`, at least 365). It is the only step that holds the audit owner's
     credentials.
- Both steps are idempotent. If one fails, fix the cause and run the service again.

**Expand, then contract.** A release normally only adds schema that the previous release still works
with, and drops or renames in a later release. That keeps a rolling restart and an image rollback safe.
When a release breaks this rule it says so, and rolling back past it means restoring a backup (see
[One-way releases](#one-way-releases)).

## Pin what you run

| Setting | Compose (`.env`) | AWS (`terraform.tfvars`) |
|---|---|---|
| OCSO images | `OCSO_IMAGE_PREFIX` and `OCSO_VERSION` (default `ocso` / `local`) | `image_tag` (ECR tags are immutable) |
| PostgreSQL image | `OCSO_POSTGRES_IMAGE` (default `postgres:18.6`) | `db.engine_version` (major pinned; minor upgrades automatic unless `auto_minor_upgrade = false`) |
| Collector, Jaeger, SeaweedFS | `OCSO_OTELCOL_IMAGE`, `OCSO_JAEGER_IMAGE`, `OCSO_SEAWEEDFS_IMAGE` | `otel_collector.image` |

Use a tag that names the commit, for example `OCSO_VERSION=2026.09.25-5a51793`. `docker compose build`
tags the images `${OCSO_IMAGE_PREFIX}/<service>:${OCSO_VERSION}`; point the prefix at your own registry to
build once and `docker compose pull` on the host.

## Upgrade on Docker Compose

1. **Back up** the main database, the audit database and the `secrets` volume
   ([Backups and restore](backups-and-restore.md)).
2. Get the new version: `git pull` (or check out the commit), then set `OCSO_VERSION` to the new tag.
3. Build, or pull prebuilt images:
   ```bash
   docker compose build          # or: docker compose pull
   ```
4. Create any new secrets and run the migrations. Stop here if it fails:
   ```bash
   docker compose up -d keygen   # adds only missing files; never touches existing ones
   docker compose run --rm migrate
   ```
5. Recreate the application containers on the new images:
   ```bash
   docker compose up -d
   ```

Pass the same `-f` files (for example `-f compose.yaml -f infra/compose/tls.yaml`) to every command if you
use overlays. `docker compose up -d --build` alone also works: Compose runs `migrate` before recreating
the api and worker. During the migration the old api keeps serving against the new schema, which is safe
under expand/contract.

## Upgrade on AWS

1. Take a manual RDS snapshot of the main and audit instances (`aws rds create-db-snapshot`).
2. Build and push the four images with a new `image_tag`.
3. Register the new migrate task definition, run it, and wait for exit code 0:
   `terraform apply -target=module.migrate -var image_tag=$TAG`, then the `aws ecs run-task` sequence in
   [Deploy on AWS](../guides/deploy/aws.md#4-run-migrations-every-deploy).
4. Only then roll the services: `terraform apply -var image_tag=$TAG`. The deployment circuit breaker
   rolls a service back if its new tasks fail health checks.

While a deploy rolls, tasks of the old and new version run side by side against the new schema, which is
why migrations must be additive.

## Roll back

- **Application only, within expand/contract releases.** Redeploy the previous image: Compose, set
  `OCSO_VERSION` back and `docker compose up -d`; AWS, `terraform apply -var image_tag=<previous>`. The
  schema stays at the newer version, which the previous release tolerates.
- **Schema.** There are no down-migrations. Fix forward with a new migration, or restore the backup taken
  before the upgrade, which discards everything since.
- **Never edit an applied migration** to "undo" it. The runner refuses to start when a checksum changes.

## One-way releases

The **governance and routing release** (role presets, maker–checker, routers and the separate audit store;
ADR-029 to ADR-033; migrations 0021 to 0031) is one-way. Migration 0021 renames the stored roles
(Platform Tech Admin → Tech, CS Lead → Head, CS Exec → Service), and an older image fails on every
authenticated request against the renamed roles. If you are upgrading a deployment from before it:

1. Take a backup first. It is the only way back.
2. Compose: `docker compose up -d keygen audit-db` creates the audit store secrets and database; back up the
   `secrets` volume again (it now holds the audit signing key). AWS: create the audit signing key secret,
   set `audit_signing_key_secret_arn`, and bump `bootstrap_secret_version` so the bootstrap secret gains the
   audit URLs (this also rotates the database password and setup token).
3. Stop the old api, worker and web (Compose `docker compose stop api worker web`; AWS scale the services to
   0), or accept errors for signed-in users during the migration.
4. Run the migrate step, then start the stack.

What changes for people: roles are mapped automatically; every object that was live is recorded as
approved (migration 0031, `origin = MIGRATION`) and keeps running, and its next change is a proposal;
each channel got a pass-through router (migration 0025); existing audit events are backfilled and shipped
to the new audit store (watch **Platform → System → Audit store** until the backlog reaches zero, then
verify the chain). **Exceptions** lists the grandfathered objects once as *installed only*.

Rolling back past this release means restoring the pre-upgrade backup, not redeploying the old image.

## PostgreSQL major upgrades

Compose mounts the data volume at `/var/lib/postgresql` (the PostgreSQL 18 image layout), so a major
upgrade (18 → 19) can use `pg_upgrade --link` or a dump and restore into a new volume. Upgrade the audit
database the same way. On AWS, `allow_major_version_upgrade` is false: a major upgrade is a planned change
you make deliberately (change `db.engine_version` and `db.parameter_group_family`, then enable it).

## Verify after an upgrade

- `docker compose ps` (or the ECS console) shows every service healthy, and `migrate` exited 0.
- `docker compose logs migrate` ends with `migrations complete` and `audit store migrations complete`.
- **Platform → System** shows no new audit store incident, and **Platform → Workers** shows the fleet
  healthy (hover a worker's id to see its version).

## Related

- [Backups and restore](backups-and-restore.md)
- [Troubleshooting](troubleshooting.md#migrations)
- [Deploy with Docker Compose](../guides/deploy/docker-compose.md)
- [Deploy on AWS](../guides/deploy/aws.md)
- [CONTRIBUTING: migrations are hand-written](../../CONTRIBUTING.md#2-migrations-are-hand-written)
