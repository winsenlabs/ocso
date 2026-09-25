# Backups and restore

What to back up in an OCSO deployment, how to do it on Docker Compose and AWS, how to restore, and how
to protect the two keys that make the backups usable: the secrets master key and the audit signing key.
For operators.

## What to back up

The pieces depend on each other. A database backup without the matching keys cannot be decrypted or
verified, so back them up together and test a restore.

| Asset | Holds | Compose | AWS (Terraform) |
|---|---|---|---|
| Main PostgreSQL | Conversations, configuration, users, approvals, queue jobs, the recent local window of audit events, and (Compose) provider, channel and MCP credentials encrypted with the master key | `pgdata` volume | RDS main instance: automated backups with PITR (`db.backup_retention_days`, default 14), Multi-AZ, final snapshot |
| Audit store | The system of record for audit events (ADR-032): the hash chain and signed checkpoints | `auditdata` volume (`audit-db`) | RDS audit instance: PITR (`audit_store.backup_retention_days`, default 35) |
| Blobs | Media, attachments and the signed daily audit exports under `audit-exports/` | `blobs` volume, or `s3data` on the `s3` profile | S3 media bucket, versioned; noncurrent versions kept `media.noncurrent_expiry_days` (30) |
| Secrets master key | `app/master_key`: the SecretStore key-encryption key (ADR-012). Without it no stored credential can be decrypted. | `secrets` volume | Not used: `SECRETS_DRIVER=aws` keeps credentials in Secrets Manager |
| Audit signing key | Ed25519 private key that signs checkpoints, exports and exception reports | `secrets` volume, `app/audit_signing_key` | Your own Secrets Manager secret (`audit_signing_key_secret_arn`) |
| Auth secret | `BETTER_AUTH_SECRET`: signs sessions and encrypts authenticator secrets and backup codes | `secrets` volume, `app/better_auth_secret` | Its own Secrets Manager secret `ocso/<env>/auth-secret`, regenerated only when `auth_secret_version` changes |
| Other generated secrets | Database and audit role passwords, setup token, blob signing key, Resend or SMTP key files | `secrets` volume | Bootstrap secret `ocso/<env>/bootstrap` (30-day recovery window) |
| Runtime credentials (AWS) | Provider keys, channel tokens, MCP credentials entered in the UI | In PostgreSQL, encrypted | Secrets Manager under `ocso/<env>/app/*`; PostgreSQL stores only ARNs |

Losing the audit signing key does not lose data, but new checkpoints are then signed by a key older
checkpoints do not trust, and the System screen opens `SIGNING_KEY_CHANGED`. Losing `BETTER_AUTH_SECRET`
signs everyone out and every user must enrol their authenticator app again.

> [!IMPORTANT]
> On AWS, RDS snapshots do not contain the runtime credentials. They live in Secrets Manager, which
> only offers a recovery window for deleted secrets, not point-in-time backups. Keep a record of which
> provider and channel credentials you would need to re-enter.

## Back up on Docker Compose

Online, from the host. Keep backups outside the repository checkout and never commit them. Volume names
carry the Compose project prefix `ocso_`; check with `docker volume ls`.

```bash
B=~/ocso-backups && mkdir -p "$B" && chmod 700 "$B" && ts=$(date +%Y%m%d-%H%M%S)
docker compose exec -T postgres pg_dump -U ocso -d ocso -Fc > "$B/ocso-$ts.dump"
docker compose exec -T audit-db pg_dump -U ocso_audit -d ocso_audit -Fc > "$B/ocso-audit-$ts.dump"
docker run --rm -v ocso_blobs:/data:ro -v "$B":/b busybox tar czf /b/blobs-$ts.tgz -C /data .
docker run --rm -v ocso_secrets:/data:ro -v "$B":/b busybox tar czf /b/secrets-$ts.tgz -C /data .
chmod 600 "$B"/*
```

On the `s3` profile, back up the `ocso_s3data` volume instead of `ocso_blobs`. Store the secrets archive
separately from the database dumps (a password manager or a KMS-encrypted object) and restrict who can
read it.

Back up the audit store at least as often as the main database.

## Restore on Docker Compose

Restore the `secrets` volume **before** PostgreSQL starts for the first time. Otherwise `keygen` creates
new keys that do not match the restored data.

```bash
docker compose down                       # add -v only if you really mean to replace all data
docker run --rm -v ocso_secrets:/data -v "$B":/b busybox tar xzf /b/secrets-<ts>.tgz -C /data
docker run --rm -v ocso_blobs:/data -v "$B":/b busybox tar xzf /b/blobs-<ts>.tgz -C /data
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U ocso -d ocso --clean --if-exists < "$B/ocso-<ts>.dump"
docker compose up -d audit-db
# The audit tables refuse DELETE and TRUNCATE: restore into a fresh, empty audit database.
docker compose exec -T audit-db pg_restore -U ocso_audit -d ocso_audit --no-privileges < "$B/ocso-audit-<ts>.dump"
docker compose up -d                      # migrate re-creates role grants and brings the schema forward
```

After the restore, workers reclaim expired conversation leases and continue from the persisted
interactions. Turns that were in flight at the moment of failure are retried; replies are idempotent, so
none is sent twice.

## Restore on AWS

These steps follow from the Terraform; none has been run against a real account.

- **Main database, AZ failure**: Multi-AZ fails over automatically to the same endpoint.
- **Main database, data loss**: point-in-time restore to a *new* identifier, then swap identifiers
  (rename the old one, give the restored one the original name) so `DATABASE_URL` stays valid. The
  password is the one current at the restore point. Run `terraform apply` to re-assert settings and force
  new deployments. If Terraform replaces the instance instead, bump `bootstrap_secret_version` so the
  secret and the new instance agree.
- **Audit instance**: restore it the same way, promptly (see below).
- **Media**: restore previous object versions. Never delete the bucket's KMS key; a key scheduled for
  deletion has a 30-day window.
- **Secrets**: `aws secretsmanager restore-secret` within the recovery window.
- **Queues**: SQS messages are only wake-ups; the work is in PostgreSQL, and the lease-recovery sweep
  re-enqueues anything lost.

Cross-region disaster recovery is not built in. Add cross-region snapshot copies and S3 replication if
you need a regional recovery objective.

## Restoring only the audit store

If the audit store is restored from a backup older than the main database, events shipped after the
backup point are missing from the store although the main database marks them verified. Reconciliation
(every 5 minutes) and the check before the local prune ship them again, but only while they are inside
the local window (`audit_local_window_days`, default and minimum 90). So:

1. Restore the store promptly, well inside the local window.
2. Watch **Platform → System → Audit store** until **Shipping** has no backlog.
3. Verify the chain (below) and run **Full check**.

The restored chain continues from the backup's head, so positions after it are sealed again with other
content than earlier exports covered. Keep those exports: each still verifies against its own manifest.

## Verify the audit chain after a restore

From the System screen, **Verify recent entries** (needs `audit.verify`, which Tech holds), or offline on
Compose:

```bash
docker compose run --rm migrate node audit-store/dist/bin/audit-verify.js --from 1
# exit 0 = verified; 1 = problems (JSON report with position and kind); 2 = could not run
```

An auditor should verify with public keys they pinned themselves (`GET /v1/audit/keys`, or
`--public-key <file>`), never with the key inside an export manifest.

## Protect the secrets

The default Compose layout protects the database and its backups: credentials are envelope-encrypted with
the master key. It does **not** protect against someone with root on the host, who can read the
`secrets` volume.

- **Restrict the host.** Docker access is root access; control membership of the `docker` group.
- **Move the master key off the data volume.** Point `OCSO_SECRETS_MASTER_KEY_FILE` (in a
  `compose.override.yaml`) at a root-only file on an encrypted disk, or fetch it at boot from your cloud's
  secret manager into a tmpfs.
- **Rotate what can be rotated.** Provider, channel and MCP credentials rotate from the web app (a new
  secret version). To rotate the blob signing key, delete `app/blob_signing_key` on the volume, run
  `docker compose up -d keygen`, then restart api and worker; outstanding signed links stop working.
- **Keep the containers hardened.** They run as non-root with a read-only root filesystem,
  `no-new-privileges` and all capabilities dropped. Do not relax this in overrides.
- **Write-once exports.** Signed audit exports are an independent copy only if the blob store keeps
  `audit-exports/` write-once. OCSO does not enforce this: neither Compose nor Terraform enables S3 Object
  Lock, and the local `blobs` volume cannot be made write-once. Configure it yourself on the bucket.

### Rotate the audit signing key

1. Keep the old public key: `openssl pkey -in old.pem -pubout > retired.pem`.
2. Compose: write the new PEM to `app/audit_signing_key` and set `AUDIT_TRUSTED_PUBLIC_KEYS_FILE` to a file
   on the secrets volume that holds the retired public keys. AWS: put the new PEM in the signing key secret
   and the retired public keys in `audit_trusted_public_keys`.
3. Restart (or force new deployments of) the api and worker.

If the `secrets` volume is ever lost, `keygen` silently creates a new signing key and the System screen
reports **Audit checkpoints were signed by a key this deployment does not trust**
(`SIGNING_KEY_CHANGED`). Restore the old key rather than trusting a new one blindly.

## Related

- [Upgrades](upgrades.md)
- [Troubleshooting](troubleshooting.md)
- [Audit](../concepts/audit.md)
- [Deploy with Docker Compose](../guides/deploy/docker-compose.md)
- [Deploy on AWS](../guides/deploy/aws.md)
