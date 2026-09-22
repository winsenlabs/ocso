import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { channels, modelProfiles, modelProviders, queueTeams, queues, teams, uuidv7, virtualAgents } from '@ocso/db';
import { AgentService, IngressService, SettingsService, type ActorContext } from '@ocso/application';
import { MemoryQueue } from '@ocso/queue';
import { ChannelRegistry } from '@ocso/channels';
import { InMemorySecretRows, LocalSecretStore, parseMasterKey } from '@ocso/secrets';
import { LocalBlobStore } from '@ocso/blob';
import { createAjvValidator } from '@ocso/tools';
import { createLogger } from '@ocso/observability';
import { randomBytes } from 'node:crypto';
import {
  ChannelRuntime,
  ContextBuilder,
  HotContextCache,
  LeaseManager,
  MediaMaterializer,
  ModelGateway,
  ToolRunner,
  TurnProcessor,
  UsageRecorder,
} from '../src/index.js';
import { ScriptedAdapter } from '../src/testing/scripted-adapter.js';
export { ScriptedAdapter, type ScriptStep } from '../src/testing/scripted-adapter.js';

export interface RuntimeHarness {
  t: TestDatabase;
  queue: MemoryQueue;
  adapter: ScriptedAdapter;
  ingress: IngressService;
  agentId: string;
  channelId: string;
  queueId: string;
  lead: ActorContext;
  processor(workerId: string, leaseSeconds?: number): { processor: TurnProcessor; leases: LeaseManager; hot: HotContextCache };
  say(text: string, id?: string, visitor?: string): Promise<string>;
}

export async function createRuntimeHarness(): Promise<RuntimeHarness> {
  const t = await createTestDatabase();
  const queue = new MemoryQueue();
  const leadId = uuidv7();
  await t.pool.query(`INSERT INTO users (id, email, name, role, availability) VALUES ($1, 'lead@x.test', 'Anjali Rao', 'CS_LEAD', 'AVAILABLE')`, [leadId]);
  const lead: ActorContext = { principal: { userId: leadId, role: 'CS_LEAD', displayName: 'Anjali Rao', teamIds: [], via: 'UI' }, correlationId: 'test' };
  const providerId = uuidv7();
  await t.db.insert(modelProviders).values({ id: providerId, kind: 'DEV_SCRIPTED', name: 'Scripted', residencyZone: 'IN' });
  const profileId = uuidv7();
  await t.db.insert(modelProfiles).values({ id: profileId, name: 'support-primary', providerId, model: 'scripted', retries: 0 });
  const teamId = uuidv7();
  const queueId = uuidv7();
  await t.db.insert(teams).values({ id: teamId, name: 'Cards' });
  await t.db.insert(queues).values({ id: queueId, name: 'Cards & EMI · Tier 2' });
  await t.db.insert(queueTeams).values({ queueId, teamId });
  const agent = await new AgentService(t.db).create(lead, { name: 'Maya', purpose: 'customer support', conversationType: 'SUPPORT', description: '', modelProfileId: profileId, defaultQueueId: queueId });
  await t.db.update(virtualAgents).set({ status: 'LIVE' }).where(eq(virtualAgents.id, agent.id));
  const channelId = uuidv7();
  await t.db.insert(channels).values({ id: channelId, kind: 'WEBCHAT', name: 'Web chat', status: 'ACTIVE', publicKey: `pk-${channelId.slice(-6)}`, defaultAgentId: agent.id });

  const adapter = new ScriptedAdapter(providerId);
  const secrets = new LocalSecretStore(new InMemorySecretRows(), parseMasterKey('k', randomBytes(32).toString('base64')));
  const blobs = new LocalBlobStore({ rootDir: `/tmp/ocso-rt-${t.name}`, publicApiBaseUrl: 'http://x', signingKey: 'k' });
  const settings = new SettingsService(t.db);
  const logger = createLogger({ service: 'test', version: '0', level: 'fatal' });
  const ingress = new IngressService(t.db, queue);
  let counter = 0;

  return {
    t,
    queue,
    adapter,
    ingress,
    agentId: agent.id,
    channelId,
    queueId,
    lead,
    processor(workerId, leaseSeconds = 30) {
      const leases = new LeaseManager(t.db, workerId, { leaseSeconds, idleSeconds: 60 });
      const hot = new HotContextCache();
      const gateway = new ModelGateway(t.db, { get: async () => adapter }, new UsageRecorder(t.db), settings);
      const channelRuntime = new ChannelRuntime(t.db, new ChannelRegistry(), secrets);
      const processor = new TurnProcessor({
        db: t.db,
        queue,
        leases,
        gateway,
        context: new ContextBuilder(t.db, hot, { historyWindow: 20, mediaWindow: 6, timezone: 'UTC' }),
        media: new MediaMaterializer(t.db, channelRuntime, blobs),
        toolRunner: (catalog) =>
          new ToolRunner(t.db, catalog, { forConnection: async () => ({ connectionId: null, invoke: async () => ({ status: 'SUCCEEDED', output: { type: 'json', value: { ok: true } }, latencyMs: 3 }) }) }, createAjvValidator(), null),
        capabilitiesFor: async () => ({ imageInput: true, fileInput: true, audioInput: false }),
        logger,
        summarizeAfter: 40,
      });
      return { processor, leases, hot };
    },
    async say(text, id, visitor = 'visitor-1') {
      const r = await ingress.receive(channelId, {
        externalMessageId: id ?? `m-${++counter}-${Date.now()}`,
        identityKind: 'webchat_visitor',
        identityValue: visitor,
        alternateIdentities: [],
        profileName: 'Priya Deshmukh',
        receivedAt: new Date(),
        parts: [{ type: 'TEXT', text }],
      }, 'test');
      if (r.status !== 'accepted') throw new Error(`ingress ${r.status}`);
      return r.conversationId;
    },
  };
}

export const turnMessage = (conversationId: string, attempt = 1) => ({
  id: uuidv7(),
  topic: 'conversation.turn' as const,
  payload: { conversationId },
  groupKey: conversationId,
  attempt,
  enqueuedAt: new Date(),
});
