import type { AlertDeliveryAdapter, DeliveryAdapterDeps } from './alerts.js';
import type { ChannelAdapter, ChannelAdapterDeps } from './channels.js';
import type { EmailDriverDefinition } from './email.js';
import type { ProviderDefinition } from './model-providers.js';

/**
 * The plugin API version this SDK describes. OCSO refuses a plugin whose
 * `apiVersion` it does not implement; a breaking change to any contract in
 * this package raises it.
 */
export const OCSO_PLUGIN_API_VERSION = 1;

/** Builds a channel adapter with OCSO's egress fetch and clock. */
export type ChannelAdapterFactory = (deps: ChannelAdapterDeps) => ChannelAdapter;

/** Builds an alert destination adapter with OCSO's egress fetch, SMTP transport and deployment email sender. */
export type AlertDestinationFactory = (deps: DeliveryAdapterDeps) => AlertDeliveryAdapter;

/**
 * An OCSO plugin (API version 1): what one npm package contributes to OCSO's
 * registries. OCSO loads it in-process at start-up, so a plugin runs with
 * OCSO's full trust.
 *
 * Adapters that need host services (the SSRF-guarded egress fetch, the
 * clock, the deployment email sender) are factories OCSO calls with them;
 * definitions that need nothing from the host are plain values.
 */
export interface OcsoPluginV1 {
  readonly apiVersion: 1;
  /** Unique across the loaded plugins; by convention the npm package name. */
  readonly name: string;
  /** Channel adapters, keyed by kind. */
  readonly channels?: readonly ChannelAdapterFactory[] | undefined;
  /** Model provider definitions, keyed by kind; `devOnly` ones need the operator's dev-provider flag. */
  readonly modelProviders?: readonly ProviderDefinition[] | undefined;
  /** Alert destination adapters, keyed by kind. */
  readonly alertDestinations?: readonly AlertDestinationFactory[] | undefined;
  /** Email drivers, selected by `EMAIL_DRIVER=<name>`. */
  readonly emailDrivers?: readonly EmailDriverDefinition[] | undefined;
}

/** Any plugin this SDK can describe (a union once there is more than one API version). */
export type OcsoPlugin = OcsoPluginV1;

/**
 * Declares a plugin. An identity function: it gives the object its type
 * (and checks it at compile time). Export the result as the module's default
 * export: `export default definePlugin({ apiVersion: 1, name: '@acme/ocso-line', channels: [createLine] })`.
 */
export function definePlugin(plugin: OcsoPluginV1): OcsoPluginV1 {
  return plugin;
}
