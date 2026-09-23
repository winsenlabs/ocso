/**
 * The deployment settings are one approvable object (PM/research/11 §4): the singleton's object id in
 * approvals, and the form fields every settings form adds to name a checker.
 */
/** Must equal @ocso/application SETTINGS_OBJECT_ID (a valid RFC 4122 uuid: approval routes validate ids). */
export const SETTINGS_OBJECT_ID = '00000000-0000-4000-8000-000000000001';
export const APPROVAL_CHECKER_FIELD = 'approvalChecker';
export const APPROVAL_REASON_FIELD = 'approvalReason';
/** The select value that asks for a bootstrap approval (nobody else can check). */
export const APPROVAL_SELF = 'self';
