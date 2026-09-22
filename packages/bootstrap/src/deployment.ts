import type { WorkerEnv } from '@ocso/config';
import { ComposeDeploymentAdapter, EcsDeploymentAdapter, type DeploymentAdapter, type DeploymentLogger } from '@ocso/deployment';

/**
 * Deployment adapter selection (docs/13 §4, ADR-023). Worker-only: the worker
 * leader is the one process with the platform's scaling permissions; the API
 * serves the outcome it records.
 */
export function createDeploymentAdapter(env: WorkerEnv, logger?: DeploymentLogger): DeploymentAdapter {
  if (env.DEPLOYMENT_DRIVER === 'ecs') {
    return new EcsDeploymentAdapter({
      cluster: env.ECS_CLUSTER ?? '',
      service: env.ECS_WORKER_SERVICE ?? '',
      metricsNamespace: env.OCSO_METRICS_NAMESPACE,
      region: env.AWS_REGION,
      agentUri: env.ECS_AGENT_URI,
      logger,
    });
  }
  return new ComposeDeploymentAdapter();
}
