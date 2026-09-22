/** Injection tokens for worker infrastructure (interfaces need explicit tokens). */
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
export const TOOL_PROVIDERS = Symbol('TOOL_PROVIDERS');
