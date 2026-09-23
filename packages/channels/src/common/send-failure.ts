import type { SendResult } from '../contract/types.js';

/** The failure branch of a SendResult; `retriable` drives outbox backoff. */
export type SendFailure = Extract<SendResult, { ok: false }>;

export function sendFailure(errorCode: string, message: string, retriable = false): SendFailure {
  return { ok: false, errorCode, message, retriable };
}
