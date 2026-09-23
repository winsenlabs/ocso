import { DomainError, ErrorCategory } from '@ocso/domain';

/** Web chat authentication failures. Messages never contain token material. */

export type WebChatAuthReason =
  | 'missing'
  | 'malformed'
  | 'bad_signature'
  | 'unsupported_algorithm'
  | 'expired'
  | 'not_yet_valid'
  | 'wrong_channel'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'host_jwt_not_enabled'
  /** Auth mode `client`: the visitor token was not opened with a session pass. */
  | 'session_pass_required'
  /** Auth mode `user`: the visitor token carries no verified user. */
  | 'user_required';

/** Missing/expired tokens are 401 (the widget should refresh); forged or misbound ones 403. */
const STATUS: Readonly<Record<WebChatAuthReason, 401 | 403>> = {
  missing: 401,
  expired: 401,
  not_yet_valid: 401,
  malformed: 403,
  bad_signature: 403,
  unsupported_algorithm: 403,
  wrong_channel: 403,
  wrong_issuer: 403,
  wrong_audience: 403,
  host_jwt_not_enabled: 403,
  session_pass_required: 401,
  user_required: 401,
};

export class WebChatAuthError extends DomainError {
  constructor(
    readonly reason: WebChatAuthReason,
    message: string,
  ) {
    super(ErrorCategory.AUTHENTICATION, `webchat_token_${reason}`, message);
  }

  get status(): 401 | 403 {
    return STATUS[this.reason];
  }
}
