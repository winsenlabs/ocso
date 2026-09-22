import type { InboundEnvelope } from '../../contract/types.js';
import { formRecord, parseFormPairs } from '../form.js';
import { normalizeTwilioMessage } from './message.js';
import { isStatusCallback, normalizeTwilioStatus } from './status.js';

/**
 * Twilio webhook body -> InboundEnvelope. One request carries exactly one
 * event: an inbound message or a status callback for a message OCSO sent
 * (both are posted to the channel's webhook URL). Call only after
 * `verifyRequest` accepted the X-Twilio-Signature.
 */

export interface TwilioParseOptions {
  /** Events for other Twilio accounts are ignored. */
  accountSid: string;
  now: () => Date;
}

export function parseTwilioWebhook(rawBody: Buffer | null, options: TwilioParseOptions): InboundEnvelope {
  const form = formRecord(parseFormPairs(rawBody));
  const envelope: InboundEnvelope = { messages: [], statuses: [], ignored: 0 };
  if (form['AccountSid']?.toLowerCase() !== options.accountSid.toLowerCase()) {
    envelope.ignored += 1;
    return envelope;
  }
  if (isStatusCallback(form)) {
    const status = normalizeTwilioStatus(form, options.now);
    if (status) envelope.statuses.push(status);
    else envelope.ignored += 1;
    return envelope;
  }
  const message = normalizeTwilioMessage(form, options.now);
  if (message) envelope.messages.push(message);
  else envelope.ignored += 1;
  return envelope;
}
