#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { AuditToolsEnv, loadEnv } from '@ocso/config';
import { verifyChain } from '../chain.js';
import { AUDIT_STORE_DRIVERS } from '../drivers.js';
import { loadSigningKey, parsePublicKey, parsePublicKeys, publicKeyOf, type AuditPublicKey } from '../signing.js';

/**
 * `audit-verify [--from N] [--to N] [--public-key FILE]... [--max-unsigned N]` —
 * re-verifies the audit store's hash chain, every record hash and every
 * checkpoint signature in the range, against the store configured by
 * AUDIT_DRIVER (reader credentials are enough; it only reads). No entry cap.
 * Trusted keys: each --public-key (SPKI PEM, several per file allowed), else the
 * public half of AUDIT_SIGNING_KEY(_FILE) plus AUDIT_TRUSTED_PUBLIC_KEYS(_FILE).
 * Fails (exit 1) when the range does not verify, when no valid checkpoint signs
 * it, when more than --max-unsigned entries (default 5000) follow the last valid
 * checkpoint, or when the store holds records but nothing was ever sealed.
 * Prints a JSON report; exit 2 on a usage or connection error. Pin the keys you
 * trust (GET /v1/audit/keys, or your own records) — never a key an export carries.
 */
const USAGE = 'usage: audit-verify [--from N] [--to N] [--public-key FILE]... [--max-unsigned N]';
const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    'public-key': { type: 'string', multiple: true },
    'max-unsigned': { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
function position(name: string, v: string | undefined, min: number): number | undefined {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v) || Number(v) < min || !Number.isSafeInteger(Number(v))) {
    console.error(JSON.stringify({ level: 'error', msg: `--${name} must be an integer ≥ ${min}; ${USAGE}` }));
    process.exit(2);
  }
  return Number(v);
}
const from = position('from', values.from, 1);
const to = position('to', values.to, 1);
const maxUnsigned = position('max-unsigned', values['max-unsigned'], 0) ?? 5000;
if (from !== undefined && to !== undefined && from > to) {
  console.error(JSON.stringify({ level: 'error', msg: '--from must not exceed --to' }));
  process.exit(2);
}
try {
  const env = loadEnv(AuditToolsEnv);
  const driver = AUDIT_STORE_DRIVERS.find((d) => d.name === env.AUDIT_DRIVER);
  if (!driver) throw new Error(`AUDIT_DRIVER=${env.AUDIT_DRIVER} is not available here`);
  const problems = driver.check?.(env) ?? [];
  if (problems.length) throw new Error(problems.join('; '));
  const keys: AuditPublicKey[] = values['public-key']?.length
    ? values['public-key'].flatMap((file) => {
        const text = readFileSync(file, 'utf8');
        return text.includes('BEGIN PUBLIC KEY') ? parsePublicKeys(text) : [parsePublicKey(text)];
      })
    : [
        ...(env.AUDIT_SIGNING_KEY || env.AUDIT_SIGNING_KEY_FILE
          ? [publicKeyOf(loadSigningKey(env.AUDIT_SIGNING_KEY?.replace(/\\n/g, '\n') ?? readFileSync(env.AUDIT_SIGNING_KEY_FILE!, 'utf8')))]
          : []),
        ...(env.AUDIT_TRUSTED_PUBLIC_KEYS ? parsePublicKeys(env.AUDIT_TRUSTED_PUBLIC_KEYS.replace(/\\n/g, '\n')) : []),
        ...(env.AUDIT_TRUSTED_PUBLIC_KEYS_FILE ? parsePublicKeys(readFileSync(env.AUDIT_TRUSTED_PUBLIC_KEYS_FILE, 'utf8')) : []),
      ];
  if (!keys.length) throw new Error('no trusted key: pass --public-key FILE or set AUDIT_SIGNING_KEY_FILE');
  const store = driver.create(env, { logger: { info: () => {}, warn: (m) => console.error(m) } });
  try {
    const report = await verifyChain(store, {
      from,
      to,
      keys,
      maxEntries: Number.MAX_SAFE_INTEGER,
      requireCheckpoint: true,
      // The unsigned-tail check only makes sense up to the head.
      maxUnsignedTail: to === undefined ? maxUnsigned : undefined,
    });
    const backlog = (await store.unsealed(1001)).length;
    const stats = await store.stats();
    if (report.head === null && stats.rows > 0) {
      report.ok = false;
      report.problems.push({ kind: 'UNSIGNED', position: 0, detail: `the store holds ${stats.rows} records but none is sealed (is the worker's audit-seal task running?)` });
    }
    if (report.truncated) report.ok = false;
    console.log(JSON.stringify({ ...report, unsealedBacklog: backlog > 1000 ? '>1000' : backlog, keys: keys.map((k) => k.keyId) }, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await store.close();
  }
} catch (err) {
  console.error(JSON.stringify({ level: 'error', msg: (err as Error).message }));
  process.exitCode = 2;
}
