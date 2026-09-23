#!/bin/sh
# OCSO container entrypoint (baked into the api / worker / migrate images).
#
# Resolves `<VAR>_FILE` indirection for settings the application only reads
# from the environment, so Compose can hand them over as files on a
# restricted secrets volume (Docker secrets pattern) instead of plain values
# in compose.yaml or `.env`. On ECS the variables arrive directly from
# Secrets Manager and this script is a no-op.
#
# Precedence: a non-empty <VAR> wins over <VAR>_FILE, so an operator can point
# at external infrastructure (e.g. DATABASE_URL for RDS) without editing the
# Compose file. The file variable is removed from the environment either way.
#
# OCSO_SECRETS_MASTER_KEY_FILE and AUDIT_SIGNING_KEY_FILE are deliberately NOT
# in the list: the app reads those files itself, so the keys never enter the
# process environment.
set -eu

for var in DATABASE_URL BLOB_SIGNING_KEY OCSO_SETUP_TOKEN BETTER_AUTH_SECRET OCSO_RECOVERY_TOKEN OCSO_DEMO_PASSWORD DEMO_MCP_TOKEN RESEND_API_KEY SMTP_PASSWORD \
  AUDIT_DATABASE_URL AUDIT_DATABASE_OWNER_URL AUDIT_READER_URL AUDIT_WRITER_PASSWORD AUDIT_READER_PASSWORD CLICKHOUSE_PASSWORD CLICKHOUSE_ADMIN_PASSWORD CLICKHOUSE_PURGE_PASSWORD; do
  file_var="${var}_FILE"
  eval "file=\${${file_var}:-}"
  eval "current=\${${var}:-}"
  unset "$file_var"
  if [ -n "$current" ] || [ -z "$file" ]; then
    # Empty strings from Compose interpolation (`${VAR:-}`) mean "not set".
    [ -n "$current" ] || unset "$var"
    continue
  fi
  if [ ! -r "$file" ]; then
    # Never print file contents, only which setting is broken.
    echo "ocso-entrypoint: ${file_var} points to a missing or unreadable file" >&2
    exit 66
  fi
  value="$(cat "$file")"
  export "${var}=${value}"
done

exec "$@"
