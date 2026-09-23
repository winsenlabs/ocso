import { DomainError, ErrorCategory, RETRIABLE_CATEGORIES } from '@ocso/domain';
import { EmailSendError, type EmailErrorCategory } from '@ocso/email';

/**
 * Errors from installed plugins. A plugin cannot throw the host's
 * `DomainError` (its own copy of the class would fail core's `instanceof`
 * checks), so the SDK's `pluginError(category, code, message, details?)`
 * marks a plain `Error` with `{ ocsoError: { category, code, details } }`.
 * The host translates marked errors at the plugin boundary: every method of
 * every installed contribution is guarded (`guardObject`), so core only ever
 * sees `DomainError`s or the plugin's other errors, unchanged.
 */
export interface PluginErrorMarker {
  category: ErrorCategory;
  code: string;
  details?: Readonly<Record<string, unknown>> | undefined;
}

const CATEGORIES: ReadonlySet<string> = new Set(Object.values(ErrorCategory));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The SDK marker of an error, or null when it has none (or a malformed one). */
export function pluginErrorMarker(error: unknown): PluginErrorMarker | null {
  if (!isRecord(error) && !(error instanceof Error)) return null;
  let marker: unknown;
  try {
    marker = (error as { ocsoError?: unknown }).ocsoError;
  } catch {
    return null;
  }
  if (!isRecord(marker)) return null;
  const { category, code, details } = marker;
  if (typeof category !== 'string' || !CATEGORIES.has(category)) return null;
  if (typeof code !== 'string' || !code) return null;
  if (details !== undefined && details !== null && !isRecord(details)) return null;
  return { category: category as ErrorCategory, code, details: isRecord(details) ? details : undefined };
}

/** A marked plugin error as the host's DomainError (original kept as `cause`); anything else unchanged. */
export function translatePluginError(error: unknown): unknown {
  if (error instanceof DomainError) return error;
  const marker = pluginErrorMarker(error);
  if (!marker) return error;
  const message = error instanceof Error ? error.message : typeof (error as { message?: unknown }).message === 'string' ? String((error as { message: string }).message) : marker.code;
  const translated = new DomainError(marker.category, marker.code, message, marker.details);
  Object.defineProperty(translated, 'cause', { value: error, enumerable: false, configurable: true, writable: true });
  return translated;
}

const EMAIL_CATEGORY: Readonly<Partial<Record<ErrorCategory, EmailErrorCategory>>> = {
  [ErrorCategory.AUTHENTICATION]: 'auth',
  [ErrorCategory.AUTHORIZATION]: 'auth',
  [ErrorCategory.VALIDATION]: 'validation',
  [ErrorCategory.POLICY_DENIED]: 'validation',
  [ErrorCategory.PROVIDER_RATE_LIMITED]: 'rate_limited',
  [ErrorCategory.CAPACITY]: 'rate_limited',
  [ErrorCategory.PROVIDER_UNAVAILABLE]: 'unavailable',
  [ErrorCategory.TOOL_UNAVAILABLE]: 'unavailable',
  [ErrorCategory.TIMEOUT]: 'network',
};

/**
 * Errors from an installed email driver's sender. Core email callers (Settings
 * test button, alert and approval notifications) only understand
 * `EmailSendError`, so a marked error becomes one: the category maps onto the
 * email categories (authentication → auth, provider_rate_limited → rate_limited,
 * timeout → network…; unmapped → unknown), `retriable` follows the host's
 * retriable categories, and a numeric `details.status` is kept as the status.
 * Unmarked errors pass through unchanged (core treats them as transient).
 */
export function translateEmailPluginError(error: unknown): unknown {
  if (error instanceof EmailSendError) return error;
  const translated = translatePluginError(error);
  if (!(translated instanceof DomainError) || translated === error) return translated;
  const status = translated.details?.['status'];
  const emailError = new EmailSendError(
    translated.message,
    RETRIABLE_CATEGORIES.has(translated.category),
    typeof status === 'number' && Number.isInteger(status) ? status : null,
    EMAIL_CATEGORY[translated.category] ?? 'unknown',
  );
  Object.defineProperty(emailError, 'cause', { value: error, enumerable: false, configurable: true, writable: true });
  return emailError;
}

/** Which nested objects of a guarded object are guarded too: properties, and results of methods. */
export interface GuardSpec {
  readonly props?: Readonly<Record<PropertyKey, GuardSpec>> | undefined;
  readonly returns?: Readonly<Record<PropertyKey, GuardSpec>> | undefined;
  /** How this object's methods translate errors (default: marked errors become DomainErrors). */
  readonly translate?: ((error: unknown) => unknown) | undefined;
}

type Translate = (error: unknown) => unknown;

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as { then?: unknown }).then === 'function';

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  typeof value === 'object' && value !== null && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';

/** Async iterables (model streams) are guarded through their iterator's next/return/throw. */
const ITERABLE: GuardSpec = { returns: { [Symbol.asyncIterator]: {} } };

function guardResult(result: unknown, spec: GuardSpec | undefined, translate: Translate): unknown {
  if (isThenable(result)) {
    return Promise.resolve(result).then(
      (value) => (spec && typeof value === 'object' && value !== null ? guardObject(value, spec) : value),
      (error: unknown) => {
        throw translate(error);
      },
    );
  }
  if (isAsyncIterable(result)) return guardObject(result, { ...spec, returns: { ...spec?.returns, ...ITERABLE.returns } });
  if (spec && typeof result === 'object' && result !== null) return guardObject(result, spec);
  return result;
}

/** `fn` called on `self`; a marked error it throws or rejects with becomes a DomainError (or what `translate` makes of it). */
export function guardFunction<F extends (...args: never[]) => unknown>(fn: F, self: unknown, spec?: GuardSpec, translate: Translate = translatePluginError): F {
  const guarded = function (this: unknown, ...args: unknown[]): unknown {
    let result: unknown;
    try {
      result = Reflect.apply(fn, self ?? this, args);
    } catch (error) {
      throw translate(error);
    }
    return guardResult(result, spec, translate);
  };
  Object.defineProperty(guarded, 'name', { value: fn.name, configurable: true });
  return guarded as unknown as F;
}

/**
 * A view of `target` whose methods translate marked errors (sync throws,
 * rejected promises, failing async iteration). Everything else reads through
 * unchanged: kinds, labels, schemas, spread, `in`, `Object.keys`. The proxy
 * sits on a blank shadow target, so frozen plugin objects work too, and each
 * method is wrapped once (stable identity) and always called on the target.
 */
export function guardObject<T extends object>(target: T, spec: GuardSpec = {}): T {
  const translate = spec.translate ?? translatePluginError;
  const cache = new Map<PropertyKey, { source: unknown; view: unknown }>();
  const view = (key: PropertyKey, value: unknown): unknown => {
    const hit = cache.get(key);
    if (hit && hit.source === value) return hit.view;
    let out = value;
    if (typeof value === 'function') out = guardFunction(value as (...args: never[]) => unknown, target, spec.returns?.[key], translate);
    else if (spec.props?.[key] && typeof value === 'object' && value !== null) out = guardObject(value, spec.props[key]);
    else return value;
    cache.set(key, { source: value, view: out });
    return out;
  };
  const read = (key: PropertyKey): unknown => {
    try {
      return Reflect.get(target, key, target);
    } catch (error) {
      throw translate(error);
    }
  };
  return new Proxy({} as T, {
    get: (_shadow, key) => view(key, read(key)),
    has: (_shadow, key) => Reflect.has(target, key),
    ownKeys: () => Reflect.ownKeys(target),
    getOwnPropertyDescriptor: (_shadow, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (!descriptor) return undefined;
      // Reported configurable: the shadow does not hold the property, so it may not claim otherwise.
      if ('value' in descriptor) return { ...descriptor, value: view(key, descriptor.value), configurable: true };
      return { ...descriptor, configurable: true };
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(target),
    set: (_shadow, key, value) => Reflect.set(target, key, value, target),
    defineProperty: (_shadow, key, descriptor) => Reflect.defineProperty(target, key, descriptor),
    deleteProperty: (_shadow, key) => Reflect.deleteProperty(target, key),
  });
}
