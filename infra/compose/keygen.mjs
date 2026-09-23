// OCSO Compose key generator — runs once per `docker compose up` as the
// `keygen` one-shot service and exits.
//
// Creates each secret ONLY IF ABSENT on the `secrets` named volume, so keys
// survive restarts and upgrades and are never regenerated underneath existing
// data. Nothing is printed except file names. Layout (one sub-directory per
// consumer, mounted with `volume.subpath` so each container sees only its own):
//
//   postgres/db_password          root 0400  read by the postgres entrypoint (as root)
//   app/master_key                1000 0400  SecretStore KEK (ADR-012) — BACK THIS UP
//   app/database_url              1000 0400  postgres://ocso:<db_password>@postgres:5432/ocso
//   app/blob_signing_key          1000 0400  HMAC for local signed blob URLs
//   app/setup_token               1000 0400  first-run /setup token
//   app/better_auth_secret        1000 0400  Better Auth secret (ADR-025): signs session cookies,
//                                            encrypts TOTP secrets — rotating it signs everyone out
//   app/demo_mcp_token            1000 0400  bearer token for the demo MCP server (demo profile)
//   app/aws_credentials           1000 0400  SeaweedFS S3 credentials (s3 profile), INI format
//   demo/demo_mcp_token           1000 0400  same token, for the demo MCP server container
//   seaweedfs/s3.json             1000 0400  SeaweedFS S3 identities (s3 profile)
//   audit-postgres/db_password    root 0400  audit store database owner password (audit-db, ADR-032)
//   audit-writer/audit_database_url 1000 0400  postgres://ocso_audit_writer:<writer>@audit-db:5432/ocso_audit
//                                            — INSERT/SELECT only; mounted by the worker alone
//   app/audit_reader_url          1000 0400  postgres://ocso_audit_reader:<reader>@audit-db:5432/ocso_audit
//                                            — SELECT only; what the api (and demo seed) use
//   app/audit_signing_key         1000 0400  Ed25519 private key (PKCS#8 PEM): signs audit checkpoints,
//                                            exports and exception reports — BACK THIS UP. If it is
//                                            ever lost, keep the old public key in the file named by
//                                            AUDIT_TRUSTED_PUBLIC_KEYS_FILE; the System screen reports
//                                            SIGNING_KEY_CHANGED when checkpoints use an untrusted key
//   audit-migrate/audit_owner_url 1000 0400  postgres://ocso_audit:<owner>@audit-db:5432/ocso_audit
//                                            — the migrate step only (schema, roles)
//   audit-migrate/audit_writer_password, audit_reader_password, audit_writer_url, audit_reader_url
//                                 1000 0400  what audit-migrate sets the two roles to
//
// uid/gid 1000 is the `node` user of the OCSO and demo images and the `seaweed`
// user SeaweedFS drops to. Owner and mode are re-applied on every run.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.env.KEYGEN_DIR ?? '/secrets';
const APP_UID = 1000;
const b64url = (bytes) => randomBytes(bytes).toString('base64url');

function dir(name, uid) {
  const path = join(ROOT, name);
  mkdirSync(path, { recursive: true });
  chownSync(path, uid, uid);
  chmodSync(path, 0o500);
  return path;
}

/** Write `value()` to dir/name unless the file already exists; returns the stored value. */
function ensure(dirPath, name, uid, value) {
  const path = join(dirPath, name);
  if (existsSync(path)) {
    chownSync(path, uid, uid);
    chmodSync(path, 0o400);
    console.log(`keygen: kept ${path}`);
    return readFileSync(path, 'utf8');
  }
  const content = value();
  writeFileSync(path, content, { mode: 0o400, flag: 'wx' });
  chownSync(path, uid, uid);
  console.log(`keygen: created ${path}`);
  return content;
}

const pg = dir('postgres', 0);
const app = dir('app', APP_UID);
const demo = dir('demo', APP_UID);
const seaweed = dir('seaweedfs', APP_UID);
const auditPg = dir('audit-postgres', 0);
const auditMigrate = dir('audit-migrate', APP_UID);
const auditWriter = dir('audit-writer', APP_UID);

// Hex keeps the password URL-safe inside DATABASE_URL.
const dbPassword = ensure(pg, 'db_password', 0, () => randomBytes(24).toString('hex'));
ensure(app, 'database_url', APP_UID, () => `postgres://ocso:${dbPassword}@postgres:5432/ocso`);
// 32 random bytes, base64 — the format parseMasterKey expects.
ensure(app, 'master_key', APP_UID, () => randomBytes(32).toString('base64'));
ensure(app, 'blob_signing_key', APP_UID, () => b64url(32));
ensure(app, 'setup_token', APP_UID, () => b64url(24));
ensure(app, 'better_auth_secret', APP_UID, () => b64url(48));

const mcpToken = ensure(app, 'demo_mcp_token', APP_UID, () => b64url(32));
ensure(demo, 'demo_mcp_token', APP_UID, () => mcpToken);

const accessKey = `ocso${randomBytes(8).toString('hex')}`;
const secretKey = b64url(30);
const s3Json = ensure(seaweed, 's3.json', APP_UID, () =>
  JSON.stringify(
    { identities: [{ name: 'ocso', credentials: [{ accessKey, secretKey }], actions: ['Read', 'Write', 'List', 'Tagging', 'Admin'] }] },
    null,
    2,
  ),
);
// Derive the app's credentials from whatever s3.json holds (it may predate this run).
const identity = JSON.parse(s3Json).identities[0].credentials[0];
ensure(app, 'aws_credentials', APP_UID, () => `[default]\naws_access_key_id = ${identity.accessKey}\naws_secret_access_key = ${identity.secretKey}\n`);

// Audit store (ADR-032): its own database server, an owner only the migrate step holds,
// a writer the api and worker use, and the Ed25519 signing key.
const auditOwnerPassword = ensure(auditPg, 'db_password', 0, () => randomBytes(24).toString('hex'));
ensure(auditMigrate, 'audit_owner_url', APP_UID, () => `postgres://ocso_audit:${auditOwnerPassword}@audit-db:5432/ocso_audit`);
const auditWriterPassword = ensure(auditMigrate, 'audit_writer_password', APP_UID, () => randomBytes(24).toString('hex'));
const auditReaderPassword = ensure(auditMigrate, 'audit_reader_password', APP_UID, () => randomBytes(24).toString('hex'));
const writerUrl = `postgres://ocso_audit_writer:${auditWriterPassword}@audit-db:5432/ocso_audit`;
const readerUrl = `postgres://ocso_audit_reader:${auditReaderPassword}@audit-db:5432/ocso_audit`;
ensure(auditMigrate, 'audit_writer_url', APP_UID, () => writerUrl);
ensure(auditMigrate, 'audit_reader_url', APP_UID, () => readerUrl);
ensure(auditWriter, 'audit_database_url', APP_UID, () => writerUrl);
ensure(app, 'audit_reader_url', APP_UID, () => readerUrl);
ensure(app, 'audit_signing_key', APP_UID, () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
