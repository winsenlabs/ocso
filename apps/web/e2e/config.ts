/**
 * E2E stack settings. Ports default away from 3000/4000 so a developer's
 * running stack is never touched; override with the env vars below.
 */
export const E2E = {
  apiPort: Number(process.env['E2E_API_PORT'] ?? 4400),
  webPort: Number(process.env['E2E_WEB_PORT'] ?? 3400),
  /** Throwaway database, dropped and recreated for every run. */
  dbName: process.env['E2E_DB_NAME'] ?? 'ocso_web_e2e',
  pgUrl: (process.env['E2E_PG_URL'] ?? 'postgres://localhost:5432').replace(/\/+$/, ''),
  setupToken: process.env['E2E_SETUP_TOKEN'] ?? 'e2e-setup-token-0123456789abcdef',
} as const;

export const apiUrl = `http://localhost:${E2E.apiPort}`;
export const webUrl = `http://localhost:${E2E.webPort}`;
export const databaseUrl = `${E2E.pgUrl}/${E2E.dbName}`;

/** Accounts the serial role flow creates. */
export const ACCOUNTS = {
  admin: { name: 'Tara Admin', email: 'tara.admin@e2e.ocso.test', password: 'correct-horse-battery-admin' },
  lead: { name: 'Leo Lead', email: 'leo.lead@e2e.ocso.test', password: 'correct-horse-battery-lead' },
  exec: { name: 'Esha Exec', email: 'esha.exec@e2e.ocso.test', password: 'correct-horse-battery-exec' },
} as const;
