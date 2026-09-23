import type { Principal, Role } from '@ocso/auth';
import {
  AgentService,
  AgentToolGrantService,
  ApprovalDecisionService,
  ApprovalService,
  createApprovalRegistry,
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
  identityGovernanceWith,
  type ActorContext,
  type AuditStore,
} from '@ocso/application';
import {
  FIRST_PARTY_PLUGINS,
  assertDrivers,
  createChannelRegistry,
  createAuditStore,
  createDriverRegistries,
  createProviderRegistry,
  createSecretStore,
  loadPlugins,
  pluginSummary,
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
  /** Maker–checker: the seed takes its agents live through proposals like anyone else, checked by the other Head. */
  approvals: ApprovalService;
  approvalDecisions: ApprovalDecisionService;
}

export interface SeedContext {
  database: Database;
  db: Db;
  config: SeedConfig;
  secrets: SecretStore;
  /** The audit store (ADR-032): the seed's marker may have left the main database's local window. Closed by the caller. */
  auditStore: AuditStore;
  services: SeedServices;
  correlationId: string;
  log: (line: string) => void;
}

/**
 * The seed's plugins: FIRST_PARTY_PLUGINS plus OCSO_PLUGINS (raw environment),
 * the same list as the api and worker, so seeded channels and providers exist
 * there. A bad list rejects (the seed fails); the loaded list is logged like
 * the api and worker log it.
 */
export async function loadSeedPlugins(
  env: Readonly<Record<string, string | undefined>> = process.env,
  log: (line: string) => void = (line) => console.log(`seed: ${line}`),
): Promise<OcsoPlugin[]> {
  const plugins = await loadPlugins({ env });
  log(pluginSummary(plugins, env['APP_VERSION'] ?? 'dev'));
  return plugins;
}

/** Registries come from the same composition root (plugins) as the api and worker. */
export function createSeedContext(database: Database, config: SeedConfig, plugins: readonly OcsoPlugin[] = FIRST_PARTY_PLUGINS): SeedContext {
  const db = database.db;
  const drivers = createDriverRegistries(plugins);
  assertDrivers(config.api, drivers);
  const secrets = createSecretStore(config.api, db, drivers);
  const auditStore = createAuditStore(config.api, { info: () => {}, warn: (msg) => console.warn(`seed: ${msg}`) }, drivers);
  const registry = createProviderRegistry(config.api, plugins);
  const channelRegistry = createChannelRegistry({ db }, plugins);
  const validateChannel = (kind: string, settings: unknown, values: Record<string, string>): string[] =>
    channelRegistry.has(kind) ? channelRegistry.get(kind).validateConfig(settings, values) : [`channel kind ${kind} is not available`];
  // Platform kinds validate channel/provider configuration and reach the MCP server when activating (COVERAGE-PLATFORM).
  const approvalRegistry = createApprovalRegistry({ platform: { secrets, validateChannel, providers: registry, publicUrl: config.api.OCSO_PUBLIC_URL } });
  const approvals = new ApprovalService(db, approvalRegistry);
  // People and their access go through maker–checker like everything else (PM/research/11 §3.4): the demo never
  // skips access approval (OCSO_DEV_SKIP_ACCESS_APPROVAL is not consulted). The first Head is the only bootstrap.
  const identity = identityGovernanceWith(approvals);
  return {
    database,
    db,
    config,
    secrets,
    auditStore,
    correlationId: `demo-seed-${Date.now().toString(36)}`,
    log: (line) => console.log(`seed: ${line}`),
    services: {
      settings: new SettingsService(db),
      // The demo's people get the documented demo password (an operator tool, not the invite flow); each is
      // created pending and activated by a checker's approval (seed steps/organization.ts).
      users: new UserService(db, { ...identity, allowInitialPasswords: true }),
      teams: new TeamService(db, identity),
      queues: new QueueService(db),
      providers: new ProviderService({ db, secrets, registry }),
      profiles: new ProfileService({ db, registry }),
      agents: new AgentService(db),
      prompts: new PromptService(db),
      escalations: new EscalationRuleService(db),
      channels: new ChannelService(db, secrets, validateChannel, (kind, publicKey) => channelRegistry.paths(kind, publicKey)),
      mcp: new McpConnectionService({ db, secrets, publicUrl: config.api.OCSO_PUBLIC_URL }),
      toolGrants: new AgentToolGrantService(db),
      approvals,
      approvalDecisions: new ApprovalDecisionService(db, approvalRegistry),
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
