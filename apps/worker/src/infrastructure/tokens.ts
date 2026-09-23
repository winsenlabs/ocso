/** Injection tokens for worker infrastructure (interfaces need explicit tokens). */
/**
 * The plugins this process runs (`OcsoPlugin[]`): the composition root's
 * FIRST_PARTY_PLUGINS followed by the installed plugins OCSO_PLUGINS pins
 * (`loadPlugins`, async). Every registry and driver is built from it; the api,
 * the worker and the seed load the same list.
 */
export const PLUGINS = Symbol('PLUGINS');
/** Infrastructure driver registries (`DriverRegistries`) built from PLUGINS; `*_DRIVER` selects from them. */
export const DRIVERS = Symbol('DRIVERS');
export const ENV = Symbol('ENV');
export const DATABASE = Symbol('DATABASE');
export const DB = Symbol('DB');
export const SECRET_STORE = Symbol('SECRET_STORE');
export const BLOB_STORE = Symbol('BLOB_STORE');
export const QUEUE = Symbol('QUEUE');
export const LISTENER = Symbol('LISTENER');
export const WORKER_ID = Symbol('WORKER_ID');
export const LOGGER = Symbol('LOGGER');
export const CHANNEL_REGISTRY = Symbol('CHANNEL_REGISTRY');
export const PROVIDER_SOURCE = Symbol('PROVIDER_SOURCE');
/** Model provider registry (`ProviderRegistry`); dev-only providers only when OCSO_ENABLE_DEV_PROVIDERS=true. */
export const PROVIDER_REGISTRY = Symbol('PROVIDER_REGISTRY');
export const TOOL_PROVIDERS = Symbol('TOOL_PROVIDERS');
/** Deployment email sender (`EmailSender` from @ocso/email), selected by EMAIL_DRIVER at start-up. */
export const EMAIL_SENDER = Symbol('EMAIL_SENDER');
/** Secret-free `EmailStatus` of that sender (driver, from, reply-to, warnings). */
export const EMAIL_STATUS = Symbol('EMAIL_STATUS');
/** Resolved email config incl. credentials — infrastructure-internal, never exported. */
export const EMAIL_CONFIG = Symbol('EMAIL_CONFIG');
/** The audit store (`AuditStore` from @ocso/audit-store), selected by AUDIT_DRIVER (ADR-032). */
export const AUDIT_STORE = Symbol('AUDIT_STORE');
/** The Ed25519 audit signing key (`AuditSigner`): checkpoints and exports. */
export const AUDIT_SIGNER = Symbol('AUDIT_SIGNER');
