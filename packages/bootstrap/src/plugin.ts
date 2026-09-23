import type { AlertDeliveryAdapter, DeliveryAdapterDeps } from '@ocso/alerts';
import type { AuditStoreDriverDefinition } from '@ocso/audit-store';
import type { SettingsService } from '@ocso/application';
import type { BlobDriverDefinition } from '@ocso/blob';
import type { ChannelAdapter, ChannelAdapterDeps } from '@ocso/channels';
import type { ApiEnv, WorkerEnv } from '@ocso/config';
import type { Db } from '@ocso/db';
import type { DeploymentDriverDefinition } from '@ocso/deployment';
import type { EmailDriverDefinition } from '@ocso/email';
import type { ProviderDefinition } from '@ocso/model-providers';
import type { QueueDriverDefinition } from '@ocso/queue';
import type { SecretStore, SecretStoreDriverDefinition } from '@ocso/secrets';
import type { ToolProviderSource } from '@ocso/tools';

/**
 * An OCSO plugin: what one package contributes to the registries. The
 * composition root (this package) registers every plugin's contributions and
 * core code only ever sees the registries, looked up by kind or driver name.
 *
 * Definitions that need nothing from the host are listed as they are (model
 * providers, drivers). Adapters that need host services — the SSRF-guarded
 * egress fetch, the clock, the deployment email sender, the database — are
 * factories the host calls with them, so a plugin never reaches the network
 * or the database on its own.
 */
export interface OcsoPlugin {
  /** Unique across the loaded plugins; by convention the npm package name. */
  readonly name: string;
  /** Channel adapters (ChannelRegistry, keyed by kind). */
  readonly channels?: readonly ChannelAdapterFactory[] | undefined;
  /** Model provider definitions (ProviderRegistry, keyed by kind); `devOnly` ones need OCSO_ENABLE_DEV_PROVIDERS. */
  readonly modelProviders?: readonly ProviderDefinition[] | undefined;
  /** Alert destination adapters (AlertDeliveryRegistry, keyed by kind). */
  readonly alertDestinations?: readonly AlertDestinationFactory[] | undefined;
  /** Tool provider sources (ToolProviderRegistry, keyed by kind): built-in tools, MCP connections. */
  readonly toolProviders?: readonly ToolProviderSourceFactory[] | undefined;
  /** Drivers selected by EMAIL_DRIVER, BLOB_DRIVER, SECRETS_DRIVER, QUEUE_DRIVER, DEPLOYMENT_DRIVER (and AUDIT_DRIVER below). */
  readonly emailDrivers?: readonly EmailDriverDefinition[] | undefined;
  readonly blobDrivers?: readonly BlobDriverDefinition<DriverEnv>[] | undefined;
  readonly secretsDrivers?: readonly SecretStoreDriverDefinition<DriverEnv>[] | undefined;
  readonly queueDrivers?: readonly QueueDriverDefinition<DriverEnv>[] | undefined;
  readonly deploymentDrivers?: readonly DeploymentDriverDefinition<WorkerEnv>[] | undefined;
  /** Audit store drivers selected by AUDIT_DRIVER (ADR-032): the separate system of record for audit events. */
  readonly auditStoreDrivers?: readonly AuditStoreDriverDefinition<DriverEnv, never>[] | undefined;
}

/** The parsed environment drivers read (api and worker share the driver settings). */
export type DriverEnv = ApiEnv | WorkerEnv;

/** Builds a channel adapter with the host's egress fetch and clock. */
export type ChannelAdapterFactory = (deps: ChannelAdapterDeps) => ChannelAdapter;

/** Builds an alert delivery adapter with the host's egress fetch, SMTP transport and deployment email sender. */
export type AlertDestinationFactory = (deps: DeliveryAdapterDeps) => AlertDeliveryAdapter;

/** What a tool provider source gets from the host when the runtime builds its registry. */
export interface ToolProviderSourceDeps {
  db: Db;
  secrets: SecretStore;
  settings: SettingsService;
}

export type ToolProviderSourceFactory = (deps: ToolProviderSourceDeps) => ToolProviderSource;

type ContributionKey = Exclude<keyof OcsoPlugin, 'name'>;
type Contribution<K extends ContributionKey> = NonNullable<OcsoPlugin[K]>[number];

/**
 * Every contribution of one kind across `plugins`, in plugin order. Refuses
 * a plugin list with a duplicate or empty name, so a misconfigured list fails
 * at start-up rather than registering something twice.
 */
export function contributions<K extends ContributionKey>(plugins: readonly OcsoPlugin[], key: K): Contribution<K>[] {
  const seen = new Set<string>();
  const out: Contribution<K>[] = [];
  for (const plugin of plugins) {
    if (!plugin.name.trim()) throw new Error('an OCSO plugin needs a name');
    if (seen.has(plugin.name)) throw new Error(`OCSO plugin ${plugin.name} is listed twice`);
    seen.add(plugin.name);
    out.push(...((plugin[key] ?? []) as readonly Contribution<K>[]));
  }
  return out;
}
