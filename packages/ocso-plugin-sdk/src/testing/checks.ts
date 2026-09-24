import { ALERT_EVENTS } from '../alerts.js';
import type { ChannelAdapterDeps } from '../channels.js';
import type { DeliveryAdapterDeps } from '../alerts.js';
import {
  CHANNEL_KIND_PATTERN,
  DESTINATION_KIND_PATTERN,
  DRIVER_NAME_PATTERN,
  MARK_CODE_PATTERN,
  PROVIDER_KIND_PATTERN,
  SETUP_FILE_KEY_PATTERN,
  SETUP_FILE_NAME_PATTERN,
  SETUP_FILE_PLACEHOLDER_PATTERN,
  WEBHOOK_SEGMENT_PATTERN,
  defaultWebhookSegment,
} from '../patterns.js';

/**
 * The checks OCSO's registries run when they register a contribution,
 * copied so a plugin author can run them without a host (and so OCSO's
 * loader can run them before registering anything). Each returns problems;
 * none throws. A repo test keeps them in agreement with the registries.
 */

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null;
const isFunction = (v: unknown): v is (...args: unknown[]) => unknown => typeof v === 'function';
const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function missingMethods(target: Obj, names: readonly string[]): string[] {
  return names.filter((n) => !isFunction(target[n]));
}

/** Stand-in network: a contribution must not reach the network while it is being built or described. */
const noNetwork = (): Promise<Response> => Promise.reject(new Error('no network while checking a plugin'));

export const CHECK_CHANNEL_DEPS: ChannelAdapterDeps = { fetch: noNetwork, now: () => new Date() };

export const CHECK_ALERT_DEPS: DeliveryAdapterDeps = {
  fetch: noNetwork,
  mailTransport: () => ({ sendMail: () => Promise.reject(new Error('no SMTP while checking a plugin')), close: () => undefined }),
  emailSender: null,
  timeoutMs: 1_000,
  now: () => new Date(),
};

const CHANNEL_METHODS = ['describe', 'capabilities', 'validateConfig', 'verifyRequest', 'parseInbound', 'fetchMedia', 'render', 'send'] as const;
const EMBED_METHODS = ['widgetConfig', 'openSession', 'identify', 'attachmentKeyPrefix'] as const;

/** ChannelRegistry.register: kind pattern, unique kind, descriptor kind, mark code, embed hooks, templates, webhook segment. */
export function checkChannels(factories: readonly unknown[], problems: string[]): void {
  const kinds = new Set<string>();
  const segments = new Set<string>();
  factories.forEach((factory, i) => {
    const at = `channels[${i}]`;
    if (!isFunction(factory)) return void problems.push(`${at}: must be a factory function (deps) => ChannelAdapter`);
    let adapter: unknown;
    try {
      adapter = factory(CHECK_CHANNEL_DEPS);
    } catch (e) {
      return void problems.push(`${at}: the factory threw: ${describeError(e)}`);
    }
    if (!isObject(adapter)) return void problems.push(`${at}: the factory must return a ChannelAdapter object`);
    const kind = adapter['kind'];
    if (typeof kind !== 'string' || !CHANNEL_KIND_PATTERN.test(kind)) return void problems.push(`${at}: invalid channel kind "${String(kind)}" (upper snake case, 2–40 characters)`);
    const label = `${at} (${kind})`;
    if (kinds.has(kind)) return void problems.push(`${label}: channel kind ${kind} is contributed twice`);
    kinds.add(kind);
    const missing = missingMethods(adapter, CHANNEL_METHODS);
    if (missing.length) return void problems.push(`${label}: missing adapter methods: ${missing.join(', ')}`);
    let descriptor: unknown;
    try {
      descriptor = (adapter['describe'] as () => unknown)();
    } catch (e) {
      return void problems.push(`${label}: describe() threw: ${describeError(e)}`);
    }
    if (!isObject(descriptor)) return void problems.push(`${label}: describe() must return a ChannelKindDescriptor`);
    if (descriptor['kind'] !== kind) problems.push(`${label}: the adapter describes itself as ${String(descriptor['kind'])}`);
    const mark = descriptor['mark'];
    const code = isObject(mark) ? mark['code'] : undefined;
    if (typeof code !== 'string' || !MARK_CODE_PATTERN.test(code)) problems.push(`${label}: invalid mark code "${String(code)}" (1–3 letters or digits)`);
    const embed = adapter['embed'];
    if (descriptor['embeddable'] !== Boolean(embed)) problems.push(`${label}: embeddable kinds (and only they) implement the embed hooks`);
    else if (isObject(embed)) {
      const missingEmbed = missingMethods(embed, EMBED_METHODS);
      if (missingEmbed.length) problems.push(`${label}: missing embed hooks: ${missingEmbed.join(', ')}`);
    }
    const templateMethods = ['listTemplates', 'createTemplate', 'sendTemplate'].filter((m) => isFunction(adapter[m])).length;
    if (Boolean(descriptor['templates']) !== (templateMethods === 3)) {
      problems.push(`${label}: describe message templates exactly when the adapter implements listTemplates, createTemplate and sendTemplate`);
    }
    checkSetupFiles(descriptor['setupFiles'], label, problems);
    const staff = descriptor['staffDestination'];
    if (staff !== undefined && typeof staff !== 'boolean') problems.push(`${label}: staffDestination must be a boolean`);
    const surface = descriptor['staffSurface'];
    if (surface !== undefined && (typeof surface !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(surface))) problems.push(`${label}: staffSurface must be lower-case a-z0-9_ (up to 32 characters)`);
    const schema = descriptor['settingsSchema'];
    const properties = isObject(schema) ? schema['properties'] : undefined;
    if (staff === true && isObject(properties) && properties['destination'] !== undefined) {
      problems.push(`${label}: the "destination" setting belongs to OCSO on staff-destination kinds; remove it from the settings schema`);
    }
    if (descriptor['inboundWebhook']) {
      const segment = descriptor['webhookSegment'] ?? defaultWebhookSegment(kind);
      if (typeof segment !== 'string' || !WEBHOOK_SEGMENT_PATTERN.test(segment)) problems.push(`${label}: invalid webhook segment "${String(segment)}"`);
      else if (segments.has(segment)) problems.push(`${label}: webhook segment "${segment}" is used twice`);
      else segments.add(segment);
    }
  });
}

const SETUP_FILE_TYPES = new Set(['application/json', 'text/yaml', 'text/plain']);

/** Descriptor `setupFiles`: keys, labels, file names, content types, size and placeholders. */
function checkSetupFiles(files: unknown, label: string, problems: string[]): void {
  if (files === undefined) return;
  if (!Array.isArray(files)) return void problems.push(`${label}: setupFiles must be an array`);
  const keys = new Set<string>();
  files.forEach((file: unknown, i) => {
    const at = `${label}: setupFiles[${i}]`;
    if (!isObject(file)) return void problems.push(`${at}: must be an object`);
    const key = file['key'];
    if (typeof key !== 'string' || !SETUP_FILE_KEY_PATTERN.test(key)) problems.push(`${at}: invalid key "${String(key)}"`);
    else if (keys.has(key)) problems.push(`${at}: duplicate key "${key}"`);
    else keys.add(key);
    if (typeof file['label'] !== 'string' || !file['label'].trim()) problems.push(`${at}: label is required`);
    if (typeof file['filename'] !== 'string' || !SETUP_FILE_NAME_PATTERN.test(file['filename'])) problems.push(`${at}: invalid filename "${String(file['filename'])}"`);
    if (!SETUP_FILE_TYPES.has(file['contentType'] as string)) problems.push(`${at}: contentType must be application/json, text/yaml or text/plain`);
    const template = file['template'];
    if (typeof template !== 'string' || !template.length) return void problems.push(`${at}: template is required`);
    if (new TextEncoder().encode(template).byteLength > 64 * 1024) problems.push(`${at}: template exceeds 64 KiB`);
    for (const match of template.matchAll(/\{\{[^}]*\}\}/g)) {
      if (!SETUP_FILE_PLACEHOLDER_PATTERN.test(match[0])) problems.push(`${at}: unknown placeholder ${match[0]} (only {{webhookUrl}} and {{settings.<key>}}; secrets are never interpolated)`);
    }
  });
}

/** ProviderRegistry.register: kind pattern, unique kind (plus the definition's required members). */
export function checkModelProviders(definitions: readonly unknown[], problems: string[]): void {
  const kinds = new Set<string>();
  definitions.forEach((definition, i) => {
    const at = `modelProviders[${i}]`;
    if (!isObject(definition)) return void problems.push(`${at}: must be a ProviderDefinition object`);
    const kind = definition['kind'];
    if (typeof kind !== 'string' || !PROVIDER_KIND_PATTERN.test(kind)) {
      return void problems.push(`${at}: provider kind "${String(kind)}" must be UPPER_SNAKE_CASE (2-40 characters)`);
    }
    const label = `${at} (${kind})`;
    if (kinds.has(kind)) problems.push(`${label}: provider kind ${kind} is contributed twice`);
    kinds.add(kind);
    const missing = missingMethods(definition, ['capabilities', 'providerOptions', 'create']);
    if (missing.length) problems.push(`${label}: missing definition methods: ${missing.join(', ')}`);
    for (const schema of ['settingsSchema', 'credentialsSchema']) {
      const value = definition[schema];
      if (!isObject(value) || !isFunction(value['safeParse'])) problems.push(`${label}: ${schema} must be a zod schema`);
    }
    if (typeof definition['devOnly'] !== 'boolean') problems.push(`${label}: devOnly must be a boolean`);
  });
}

const ADAPTER_METHODS = ['validateConfig', 'validateSecret', 'summary', 'deliver'] as const;

/** AlertDeliveryRegistry.register: kind pattern, unique kind, events non-empty and known. */
export function checkAlertDestinations(factories: readonly unknown[], problems: string[]): void {
  const kinds = new Set<string>();
  factories.forEach((factory, i) => {
    const at = `alertDestinations[${i}]`;
    if (!isFunction(factory)) return void problems.push(`${at}: must be a factory function (deps) => AlertDeliveryAdapter`);
    let adapter: unknown;
    try {
      adapter = factory(CHECK_ALERT_DEPS);
    } catch (e) {
      return void problems.push(`${at}: the factory threw: ${describeError(e)}`);
    }
    if (!isObject(adapter)) return void problems.push(`${at}: the factory must return an AlertDeliveryAdapter object`);
    const kind = adapter['kind'];
    if (typeof kind !== 'string' || !DESTINATION_KIND_PATTERN.test(kind)) return void problems.push(`${at}: alert destination kind "${String(kind)}" must be upper snake case`);
    const label = `${at} (${kind})`;
    if (kinds.has(kind)) problems.push(`${label}: alert destination kind ${kind} is contributed twice`);
    kinds.add(kind);
    const events = adapter['events'];
    if (!Array.isArray(events) || !events.length || events.some((e) => !(ALERT_EVENTS as readonly unknown[]).includes(e))) {
      problems.push(`${label}: must receive known lifecycle events (a non-empty subset of ${ALERT_EVENTS.join(', ')})`);
    }
    const missing = missingMethods(adapter, ADAPTER_METHODS);
    if (missing.length) problems.push(`${label}: missing adapter methods: ${missing.join(', ')}`);
  });
}

/** DriverRegistry.register (email): name pattern, unique name. */
export function checkEmailDrivers(drivers: readonly unknown[], problems: string[]): void {
  const names = new Set<string>();
  drivers.forEach((driver, i) => {
    const at = `emailDrivers[${i}]`;
    if (!isObject(driver)) return void problems.push(`${at}: must be an EmailDriverDefinition object`);
    const name = driver['name'];
    if (typeof name !== 'string' || !DRIVER_NAME_PATTERN.test(name)) {
      return void problems.push(`${at}: email driver name "${String(name)}" must be lower case a-z0-9- (1-40 characters)`);
    }
    const label = `${at} (${name})`;
    if (names.has(name)) problems.push(`${label}: email driver ${name} is contributed twice`);
    names.add(name);
    const missing = missingMethods(driver, ['resolve', 'create']);
    if (missing.length) problems.push(`${label}: missing driver methods: ${missing.join(', ')}`);
  });
}
