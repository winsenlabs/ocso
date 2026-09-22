import type { WorkerEnv } from '@ocso/config';
import type { DeploymentAdapter, DeploymentLogger } from '@ocso/deployment';
import { createDriverRegistries, selectDriver, type DriverRegistries } from './adapters.js';

/**
 * Deployment adapter selection (docs/13 §4, ADR-023): the registered driver
 * DEPLOYMENT_DRIVER names. Worker-only: the worker leader is the one process
 * with the platform's scaling permissions; the API serves the outcome it records.
 */
export function createDeploymentAdapter(env: WorkerEnv, logger?: DeploymentLogger, drivers: DriverRegistries = createDriverRegistries()): DeploymentAdapter {
  return selectDriver(drivers.deployment, env.DEPLOYMENT_DRIVER, env).create(env, { logger });
}
