import { DomainError, ErrorCategory } from '@ocso/domain';

/** Errors raised by deployment adapters; raw SDK exceptions never leave the package. */
export class DeploymentError extends DomainError {}

const MAX_MESSAGE = 400;

export const deploymentMisconfigured = (message: string): DeploymentError =>
  new DeploymentError(ErrorCategory.VALIDATION, 'deployment_misconfigured', message);

export const scalableTargetMissing = (resourceId: string): DeploymentError =>
  new DeploymentError(
    ErrorCategory.NOT_FOUND,
    'scalable_target_missing',
    `No Application Auto Scaling target is registered for ${resourceId}. Terraform creates it (modules/autoscaling); OCSO only updates it.`,
    { resourceId },
  );

/**
 * Wrap an AWS SDK failure. The category follows the AWS error name so callers
 * can tell permissions problems from throttling; the message keeps the AWS
 * error name and text (no credentials ever appear in them).
 */
export function awsCallFailed(operation: string, err: unknown): DeploymentError {
  const name = err instanceof Error ? err.name : 'UnknownError';
  const text = err instanceof Error ? err.message : String(err);
  const category = /AccessDenied|Unauthorized|NotAuthorized/i.test(name)
    ? ErrorCategory.POLICY_DENIED
    : /Throttl|TooManyRequests|RateExceeded|LimitExceeded/i.test(name)
      ? ErrorCategory.PROVIDER_RATE_LIMITED
      : ErrorCategory.PROVIDER_UNAVAILABLE;
  const message = `${operation} failed: ${name}: ${text}`.slice(0, MAX_MESSAGE);
  return new DeploymentError(category, 'deployment_aws_call_failed', message, { operation, awsError: name });
}

/** Run one AWS call and normalize its failure. */
export async function aws<T>(operation: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof DeploymentError) throw err;
    throw awsCallFailed(operation, err);
  }
}
