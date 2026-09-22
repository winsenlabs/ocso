/** Injection tokens for infrastructure adapters (interfaces, so they need explicit tokens). */
export const ENV = Symbol('ENV');
export const DATABASE = Symbol('DATABASE');
export const DB = Symbol('DB');
export const SECRET_STORE = Symbol('SECRET_STORE');
export const BLOB_STORE = Symbol('BLOB_STORE');
export const QUEUE = Symbol('QUEUE');
export const SETUP_TOKEN = Symbol('SETUP_TOKEN');
export const CHANNEL_REGISTRY = Symbol('CHANNEL_REGISTRY');
/** Deployment email sender (`EmailSender` from @ocso/email), selected by EMAIL_DRIVER at start-up. */
export const EMAIL_SENDER = Symbol('EMAIL_SENDER');
/** Secret-free `EmailStatus` of that sender (driver, from, reply-to, warnings). */
export const EMAIL_STATUS = Symbol('EMAIL_STATUS');
/** Resolved email config incl. credentials — infrastructure-internal, never exported. */
export const EMAIL_CONFIG = Symbol('EMAIL_CONFIG');
/** OCSO's Better Auth server (`AuthServer` from @ocso/application/auth-server), ADR-025. */
export const AUTH = Symbol('AUTH');
/** Session policy (idle/absolute lifetime, sign-in throttling) from the environment. */
export const SESSION_POLICY = Symbol('SESSION_POLICY');
