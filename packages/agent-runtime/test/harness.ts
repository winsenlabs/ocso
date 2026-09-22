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
import type { ModelCapabilities, ModelProviderAdapter, ModelRequest, ModelResult, ModelStreamEvent } from '@ocso/model-providers';
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

/** Scripted model: each call pops the next step (text and/or tool calls). */
export interface ScriptStep {
  text?: string;
  toolCalls?: Array<{ toolName: string; input: unknown }>;
  delayMs?: number;
  error?: Error;
}

export class ScriptedAdapter implements ModelProviderAdapter {
  readonly kind = 'DEV_SCRIPTED' as const;
  requests: ModelRequest[] = [];
  constructor(readonly providerId: string, public script: ScriptStep[] = []) {}

  capabilities(): ModelCapabilities {
    return { imageInput: true, fileInput: true, audioInput: false, toolCalling: true, structuredOutput: true, reasoning: false, streaming: true, promptCaching: 'EXPLICIT', reportsCacheWrites: true };
  }

  async generate(request: ModelRequest): Promise<ModelResult> {
    this.requests.push(request);
    const step = this.script.shift() ?? { text: 'OK.' };
    if (step.delayMs) await new Promise((r, reject) => {
      const timer = setTimeout(r, step.delayMs);
      request.abortSignal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      });
    });
    if (step.error) throw step.error;
    return {
      text: step.text ?? '',
      toolCalls: (step.toolCalls ?? []).map((c, i) => ({ toolCallId: `call_${this.requests.length}_${i}`, toolName: c.toolName, input: c.input })),
      finishReason: step.toolCalls?.length ? 'tool-calls' : 'stop',
      usage: { inputTokens: 1200, uncachedInputTokens: 200, cachedInputTokens: 1000, cacheWriteTokens: 0, outputTokens: 40, reasoningTokens: null },
      identity: { providerId: this.providerId, kind: 'DEV_SCRIPTED', model: 'scripted', region: null, requestId: 'req' },
      latencyMs: 5,
      ttftMs: 2,
      warnings: [],
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const result = await this.generate(request);
    if (result.text) yield { type: 'text-delta', text: result.text };
    yield { type: 'finish', result };
  }

  async health() {
    return { status: 'OK' as const, latencyMs: 1, checkedAt: new Date().toISOString() };
  }
}

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
  say(text: string, id?: string): Promise<string>;
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
    async say(text, id) {
      const r = await ingress.receive(channelId, {
        externalMessageId: id ?? `m-${++counter}-${Date.now()}`,
        identityKind: 'webchat_visitor',
        identityValue: 'visitor-1',
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
