import { DomainError, ErrorCategory } from '@ocso/domain';

/**
 * Thrown by AlertDeliveryService when an adapter reports a transient failure
 * and attempts remain. `retriable` is true (PROVIDER_UNAVAILABLE), so the
 * worker's `alert.deliver` consumer answers `{ kind: 'retry' }` with backoff.
 * The message carries the adapter's secret-free reason only.
 */
export class AlertDeliveryRetryableError extends DomainError {
  constructor(
    readonly deliveryId: string,
    readonly attempts: number,
    reason: string,
  ) {
    super(ErrorCategory.PROVIDER_UNAVAILABLE, 'alert_delivery_retry', `alert delivery failed (attempt ${attempts}): ${reason}`, {
      deliveryId,
      attempts,
    });
  }
}

export const isAlertDeliveryRetryable = (e: unknown): e is AlertDeliveryRetryableError => e instanceof AlertDeliveryRetryableError;
