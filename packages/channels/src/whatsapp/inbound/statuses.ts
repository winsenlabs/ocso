import type { DeliveryStatus } from '@ocso/domain';
import type { DeliveryStatusUpdate } from '../../contract/types.js';
import { clip } from '../../common/text.js';
import { normalizeBsuid, normalizePhone } from '../identity.js';
import { unixSecondsToDate, WaStatus } from './schema.js';

/**
 * Outbound delivery receipts (`value.statuses[]`). Consumers dedupe on
 * (externalMessageId, status) and apply `nextDeliveryStatus` so late or
 * repeated receipts never move a message backwards.
 */
const STATUS_MAP: ReadonlyMap<string, DeliveryStatus> = new Map<string, DeliveryStatus>([
  ['sent', 'SENT'],
  ['delivered', 'DELIVERED'],
  ['read', 'READ'],
  ['failed', 'FAILED'],
]);

export function normalizeStatus(raw: unknown, now: () => Date): DeliveryStatusUpdate | null {
  const parsed = WaStatus.safeParse(raw);
  if (!parsed.success) return null;
  const status = STATUS_MAP.get(parsed.data.status);
  if (!status) return null;
  const { id, timestamp, recipient_id, recipient_user_id, errors } = parsed.data;
  const error = errors[0];
  const errorTitle = error?.title ?? error?.message;
  return {
    externalMessageId: id,
    status,
    occurredAt: unixSecondsToDate(timestamp, now),
    recipientId: normalizeBsuid(recipient_user_id) ?? normalizePhone(recipient_id),
    errorCode: error?.code === undefined ? undefined : String(error.code),
    errorTitle: errorTitle ? clip(errorTitle, 200) : undefined,
  };
}
