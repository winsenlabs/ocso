#!/usr/bin/env node
import { AuditToolsEnv, loadEnv } from '@ocso/config';
import { AUDIT_STORE_DRIVERS } from '../drivers.js';

/**
 * Deployment step (the Compose `migrate` service runs it after the main
 * migrations; ECS: the migrate task): applies the selected audit store
 * driver's schema with owner credentials and ensures the writer role/user.
 * Takes no arguments. Never run by the api or worker.
 */
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ level: 'info', msg, ...extra }));
try {
  const env = loadEnv(AuditToolsEnv);
  const driver = AUDIT_STORE_DRIVERS.find((d) => d.name === env.AUDIT_DRIVER);
  if (!driver?.provision) {
    throw new Error(`AUDIT_DRIVER=${env.AUDIT_DRIVER} has no provisioning here; drivers: ${AUDIT_STORE_DRIVERS.map((d) => d.name).join(', ')}`);
  }
  const report = await driver.provision(env, { log: (m) => log(m) });
  log('audit store migrations complete', { driver: driver.name, applied: report.applied.length, writer: report.writer, roleProvisioned: report.roleProvisioned });
} catch (err) {
  console.error(JSON.stringify({ level: 'error', msg: (err as Error).message }));
  process.exitCode = 1;
}
