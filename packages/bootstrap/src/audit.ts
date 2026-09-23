import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { generateSigningKeyPem, loadSigningKey, parsePublicKeys, type AuditSigner, type AuditStore, type AuditStoreLogger } from '@ocso/audit-store';
import { createDriverRegistries, selectDriver, type DriverRegistries } from './adapters.js';
import type { DriverEnv } from './plugin.js';

/**
 * The audit store this process writes to and reads from (ADR-032), built by
 * the driver AUDIT_DRIVER selects with the credentials it is given (the
 * worker: the writer; the api: the read-only reader where deployed). HTTP-based
 * drivers get the platform fetch: the store is operator infrastructure on the
 * deployment's own network, not user-supplied egress.
 */
export function createAuditStore(env: DriverEnv, logger: AuditStoreLogger, drivers: DriverRegistries = createDriverRegistries()): AuditStore {
  return selectDriver(drivers.audit, env.AUDIT_DRIVER, env).create(env, { logger, fetch: globalThis.fetch.bind(globalThis) });
}

type SignerEnv = Pick<DriverEnv, 'NODE_ENV' | 'AUDIT_SIGNING_KEY_FILE'> & {
  AUDIT_SIGNING_KEY?: string | undefined;
  AUDIT_TRUSTED_PUBLIC_KEYS_FILE?: string | undefined;
  AUDIT_TRUSTED_PUBLIC_KEYS?: string | undefined;
};

/**
 * The Ed25519 key that signs audit checkpoints, exports and exception reports
 * (AUDIT_SIGNING_KEY_FILE, PKCS#8 PEM; or AUDIT_SIGNING_KEY inline, where `\n`
 * escapes are accepted), with the retired public keys older signatures verify
 * against (AUDIT_TRUSTED_PUBLIC_KEYS inline and/or AUDIT_TRUSTED_PUBLIC_KEYS_FILE). Production refuses to start without
 * it (assertDrivers). Elsewhere a missing key means a development key kept in
 * `devKeyPath` (default `.ocso/audit_signing_key.pem` at the workspace root),
 * created on first use, so the api and worker under `pnpm dev` share one key
 * and signatures verify across restarts.
 */
export function loadAuditSigner(env: SignerEnv, logger: Pick<AuditStoreLogger, 'warn'>, devKeyPath: string = defaultDevKeyPath()): AuditSigner {
  const signer = loadKey(env, logger, devKeyPath);
  const bundle = [env.AUDIT_TRUSTED_PUBLIC_KEYS?.replace(/\\n/g, '\n') ?? '', env.AUDIT_TRUSTED_PUBLIC_KEYS_FILE ? readFileSync(env.AUDIT_TRUSTED_PUBLIC_KEYS_FILE, 'utf8') : ''].join('\n');
  if (!bundle.trim()) return signer;
  const retiredKeys = parsePublicKeys(bundle).filter((k, i, all) => k.keyId !== signer.keyId && all.findIndex((o) => o.keyId === k.keyId) === i);
  return { ...signer, retiredKeys };
}

function loadKey(env: SignerEnv, logger: Pick<AuditStoreLogger, 'warn'>, devKeyPath: string): AuditSigner {
  if (env.AUDIT_SIGNING_KEY) return loadSigningKey(env.AUDIT_SIGNING_KEY.replace(/\\n/g, '\n'));
  if (env.AUDIT_SIGNING_KEY_FILE) return loadSigningKey(readFileSync(env.AUDIT_SIGNING_KEY_FILE, 'utf8'));
  if (env.NODE_ENV === 'production') throw new Error('Invalid OCSO configuration:\n  - AUDIT_SIGNING_KEY_FILE (or AUDIT_SIGNING_KEY) is required in production');
  logger.warn(`AUDIT_SIGNING_KEY_FILE is not set: audit checkpoints are signed with the development key in ${devKeyPath} (development only)`);
  try {
    mkdirSync(dirname(devKeyPath), { recursive: true, mode: 0o700 });
    try {
      // 'wx': the first process creates it; a concurrent one reads what the first wrote.
      writeFileSync(devKeyPath, generateSigningKeyPem(), { mode: 0o600, flag: 'wx' });
    } catch (err) {
      if ((err as { code?: string }).code !== 'EEXIST') throw err;
    }
    return loadSigningKey(readFileSync(devKeyPath, 'utf8'));
  } catch (err) {
    logger.warn(`could not keep the development audit key in ${devKeyPath} (${(err as Error).message}); using an ephemeral key that changes on restart`);
    return loadSigningKey(generateSigningKeyPem());
  }
}

/** `<workspace root>/.ocso/audit_signing_key.pem` (the directory holding pnpm-workspace.yaml), else the temp directory. */
function defaultDevKeyPath(): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return join(dir, '.ocso', 'audit_signing_key.pem');
    if (dirname(dir) === dir) return join(tmpdir(), 'ocso-dev', 'audit_signing_key.pem');
  }
}
