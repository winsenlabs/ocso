import { defineConfig, devices } from '@playwright/test';
import { E2E, apiUrl, webUrl } from './e2e/config';

/**
 * E2E against a locally started stack: throwaway Postgres DB → migrations →
 * built API → production web build (standalone server). The API launcher
 * drops the database when Playwright stops it.
 * Prerequisite: `npx turbo run build --filter=@ocso/api...` from the repo root.
 * The flows are one serial story (setup → roles), so run with a single worker.
 */
/** Server logs are noisy; E2E_VERBOSE=1 streams them. */
const stdout = process.env['E2E_VERBOSE'] === '1' ? 'pipe' : 'ignore';

const stackEnv = {
  E2E_API_PORT: String(E2E.apiPort),
  E2E_WEB_PORT: String(E2E.webPort),
  E2E_DB_NAME: E2E.dbName,
  E2E_PG_URL: E2E.pgUrl,
  E2E_SETUP_TOKEN: E2E.setupToken,
};

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: webUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: 'node e2e/stack/start-api.mjs',
      url: `${apiUrl}/health/live`,
      env: stackEnv,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout,
      stderr: 'pipe',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
    {
      command: 'node e2e/stack/start-web.mjs',
      url: `${webUrl}/login`,
      env: stackEnv,
      timeout: 240_000,
      reuseExistingServer: false,
      stdout,
      stderr: 'pipe',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
  ],
});
