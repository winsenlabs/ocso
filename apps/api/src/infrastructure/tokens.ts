/** Injection tokens for infrastructure adapters (interfaces, so they need explicit tokens). */
export const ENV = Symbol('ENV');
export const DATABASE = Symbol('DATABASE');
export const DB = Symbol('DB');
export const SECRET_STORE = Symbol('SECRET_STORE');
export const BLOB_STORE = Symbol('BLOB_STORE');
export const QUEUE = Symbol('QUEUE');
export const SETUP_TOKEN = Symbol('SETUP_TOKEN');
