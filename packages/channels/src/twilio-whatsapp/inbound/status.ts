import type { DeliveryStatus } from '@ocso/domain';
import type { DeliveryStatusUpdate } from '../../contract/types.js';
import { clip, nonEmpty } from '../../common/text.js';
import type { FormRecord } from '../form.js';
import { phoneFromWhatsAppAddress } from '../identity.js';

/**
 * Status callbacks (PM/research/06 §3). Twilio does not guarantee order, so
 * consumers apply `nextDeliveryStatus` (never backwards; FAILED terminal).
 * Pre-send states (queued, accepted, sending, scheduled) and `canceled` carry
 * nothing OCSO tracks and are ignored; `undelivered` is a failure.
 */

const STATUS_MAP: ReadonlyMap<string, DeliveryStatus> = new Map<string, DeliveryStatus>([
  ['sent', 'SENT'],
  ['delivered', 'DELIVERED'],
  ['read', 'READ'],
  ['failed', 'FAILED'],
  ['undelivered', 'FAILED'],
]);

/** Inbound message webhooks carry no MessageStatus (only SmsStatus=received). */
export function isStatusCallback(form: FormRecord): boolean {
  const status = nonEmpty(form['MessageStatus'])?.toLowerCase();
  return status !== undefined && status !== 'received' && status !== 'receiving';
}

export function normalizeTwilioStatus(form: FormRecord, now: () => Date): DeliveryStatusUpdate | null {
  const sid = nonEmpty(form['MessageSid']) ?? nonEmpty(form['SmsSid']);
  const status = STATUS_MAP.get(nonEmpty(form['MessageStatus'])?.toLowerCase() ?? '');
  if (!sid || !status) return null;
  const errorCode = nonEmpty(form['ErrorCode']);
  const errorTitle = nonEmpty(form['ChannelStatusMessage']) ?? nonEmpty(form['ErrorMessage']);
  return {
    externalMessageId: sid,
    status,
    occurredAt: now(),
    recipientId: phoneFromWhatsAppAddress(form['To']),
    errorCode: errorCode && errorCode !== '0' ? clip(errorCode, 20) : undefined,
    errorTitle: errorTitle ? clip(errorTitle, 200) : undefined,
  };
}
