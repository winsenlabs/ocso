import type { Principal, Role } from '@ocso/auth';
import {
  AgentService,
  AgentToolGrantService,
  ChannelService,
  EscalationRuleService,
  McpConnectionService,
  ProfileService,
  PromptService,
  ProviderService,
  QueueService,
  SettingsService,
  TeamService,
  UserService,
  type ActorContext,
} from '@ocso/application';
import {
  FIRST_PARTY_PLUGINS,
  assertDrivers,
  createChannelRegistry,
  createDriverRegistries,
  createProviderRegistry,
  createSecretStore,
  type OcsoPlugin,
} from '@ocso/bootstrap';
import type { Database, Db } from '@ocso/db';
import type { SecretStore } from '@ocso/secrets';
import type { SeedConfig } from './config.js';

/**
 * Application services the seed drives. Every write goes through these (never
 * raw inserts), so authorization, validation, audit records and cache
 * invalidation are exactly what a person clicking through the UI produces.
 */
export interface SeedServices {
  settings: SettingsService;
  users: UserService;
  teams: TeamService;
  queues: QueueService;
  providers: ProviderService;
  profiles: ProfileService;
  agents: AgentService;
  prompts: PromptService;
  escalations: EscalationRuleService;
  channels: ChannelService;
  mcp: McpConnectionService;
  toolGrants: AgentToolGrantService;
}

export interface SeedContext {
  database: Database;
  db: Db;
  config: SeedConfig;
  secrets: SecretStore;
  services: SeedServices;
  correlationId: string;
  log: (line: string) => void;
}

/** Registries come from the same composition root (plugins) as the api and worker. */
export function createSeedContext(database: Database, config: SeedConfig, plugins: readonly OcsoPlugin[] = FIRST_PARTY_PLUGINS): SeedContext {
  const db = database.db;
  const drivers = createDriverRegistries(plugins);
  assertDrivers(config.api, drivers);
  const secrets = createSecretStore(config.api, db, drivers);
  const registry = createProviderRegistry(config.api, plugins);
  const channelRegistry = createChannelRegistry({ db }, plugins);
  const validateChannel = (kind: string, settings: unknown, values: Record<string, string>): string[] =>
    channelRegistry.has(kind) ? channelRegistry.get(kind).validateConfig(settings, values) : [`channel kind ${kind} is not available`];
  return {
    database,
    db,
    config,
    secrets,
    correlationId: `demo-seed-${Date.now().toString(36)}`,
    log: (line) => console.log(`seed: ${line}`),
    services: {
      settings: new SettingsService(db),
      // The demo's people get the documented demo password (an operator tool, not the invite flow).
      users: new UserService(db, { allowInitialPasswords: true }),
      teams: new TeamService(db),
      queues: new QueueService(db),
      providers: new ProviderService({ db, secrets, registry }),
      profiles: new ProfileService({ db, registry }),
      agents: new AgentService(db),
      prompts: new PromptService(db),
      escalations: new EscalationRuleService(db),
      channels: new ChannelService(db, secrets, validateChannel, (kind, publicKey) => channelRegistry.paths(kind, publicKey)),
      mcp: new McpConnectionService({ db, secrets, publicUrl: config.api.OCSO_PUBLIC_URL }),
      toolGrants: new AgentToolGrantService(db),
    },
  };
}

/**
 * An actor for a seeded person. `via: SYSTEM` keeps the audit trail honest:
 * the change is attributed to that person's account but marked as automated.
 */
export function actorFor(ctx: SeedContext, user: { id: string; name: string; role: Role; teamIds?: readonly string[] }): ActorContext {
  const principal: Principal = { userId: user.id, role: user.role, displayName: user.name, teamIds: user.teamIds ?? [], via: 'SYSTEM' };
  return { principal, correlationId: ctx.correlationId };
}
