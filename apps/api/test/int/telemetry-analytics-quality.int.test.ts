import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { conversations, jobs, teamMembers, teams, users, uuidv7 } from '@ocso/db';
import type { Principal } from '@ocso/auth';

const PASSWORD = 'a password 12345';
let db: TestDatabase;
let app: INestApplication;
const http = () => request(app.getHttpServer());
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const tokens: Record<'admin' | 'lead' | 'exec', string> = { admin: '', lead: '', exec: '' };
const ids: Record<string, string> = {};

async function bootApi(): Promise<INestApplication> {
  const { Module, StandardSchemaValidationPipe } = await import('@nestjs/common');
  const { APP_FILTER, APP_GUARD } = await import('@nestjs/core');
  const { Test } = await import('@nestjs/testing');
  const { LoggerModule } = await import('nestjs-pino');
  const { InfrastructureModule } = await import('../../src/infrastructure/infrastructure.module.js');
  const { ChannelsModule } = await import('../../src/modules/channels/channels.module.js');
  const { RealtimeModule } = await import('../../src/modules/realtime/realtime.module.js');
  const { TelemetryModule } = await import('../../src/modules/telemetry/telemetry.module.js');
  const { AnalyticsModule } = await import('../../src/modules/analytics/analytics.module.js');
  const { QualityModule } = await import('../../src/modules/quality/quality.module.js');
  const { AuthGuard } = await import('../../src/common/auth.guard.js');
  const { OcsoExceptionFilter } = await import('../../src/common/exception.filter.js');
  const { correlationMiddleware } = await import('../../src/common/correlation.js');
  // Local module (not AppModule): infrastructure + the modules under test.
  class TestApiModule {}
  Module({
    imports: [LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }), InfrastructureModule, RealtimeModule, ChannelsModule, TelemetryModule, AnalyticsModule, QualityModule],
    providers: [
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_FILTER, useClass: OcsoExceptionFilter },
    ],
  })(TestApiModule);
  const moduleRef = await Test.createTestingModule({ imports: [TestApiModule] }).compile();
  const nest = moduleRef.createNestApplication({ rawBody: true, logger: false });
  nest.use(correlationMiddleware);
  nest.useGlobalPipes(new StandardSchemaValidationPipe());
  await nest.init();
  return nest;
}

beforeAll(async () => {
  db = await createTestDatabase();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: db.url,
    BLOB_SIGNING_KEY: 'test-blob-signing-key-0123456789',
    OCSO_SECRETS_MASTER_KEY: randomBytes(32).toString('base64'),
    OCSO_SETUP_TOKEN: 'integration-setup-token-1',
    BLOB_LOCAL_DIR: `/tmp/ocso-test-blobs-${db.name}`,
    LOG_LEVEL: 'error',
    OCSO_TRACE_URL_TEMPLATE: 'http://localhost:16686/trace/{traceId}',
  });
  app = await bootApi();
  const { AgentService, ChannelService, IngressService, hashPassword, setPasswordCredential } = await import('@ocso/application');
  const { AUTH } = await import('../../src/infrastructure/tokens.js');
  const auth = app.get<{ handler(r: Request): Promise<Response> }>(AUTH);
  const hash = await hashPassword(PASSWORD);
  ids.team = uuidv7();
  await db.db.insert(teams).values({ id: ids.team, name: 'Cards' });
  for (const [key, role, name] of [['admin', 'TECH', 'T. Shetty'], ['lead', 'HEAD', 'Anjali Rao'], ['exec', 'SERVICE', 'Nikhil Menon']] as const) {
    ids[key] = uuidv7();
    await db.db.insert(users).values({ id: ids[key]!, email: `${key}@ocso.test`, name, role, emailVerified: true, availability: 'AVAILABLE' });
    await setPasswordCredential(db.db, ids[key]!, hash);
    // Better Auth sign-in (ADR-025); the bearer token comes back in `set-auth-token`.
    const signIn = await auth.handler(new Request('http://localhost:3000/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `${key}@ocso.test`, password: PASSWORD }) }));
    tokens[key] = signIn.headers.get('set-auth-token') ?? '';
  }
  // The lead is in Cards, the team that owns Maya (ADR-026: leads reach agents through their teams).
  await db.db.insert(teamMembers).values([
    { teamId: ids.team, userId: ids.exec! },
    { teamId: ids.team, userId: ids.lead! },
  ]);
  const principal = (key: 'admin' | 'lead'): Principal => ({ userId: ids[key]!, role: key === 'admin' ? 'TECH' : 'HEAD', displayName: key, teamIds: key === 'lead' ? [ids.team!] : [], via: 'UI' });
  ids.agent = (await new AgentService(db.db).create({ principal: principal('lead'), correlationId: 't' }, { name: 'Maya', purpose: 'customer support', conversationType: 'SUPPORT', description: '', teamIds: [ids.team!] })).id;
  ids.secret = randomBytes(32).toString('hex');
  const channel = await app.get(ChannelService).create({ principal: principal('admin'), correlationId: 't' }, { kind: 'WEBCHAT', name: 'Web chat', status: 'ACTIVE', settings: {}, secrets: { visitorTokenSecret: ids.secret }, defaultAgentId: ids.agent });
  ids.channel = channel.id;
  ids.publicKey = channel.publicKey;
  const { issueVisitorToken } = await import('@ocso/channels');
  const visitor = issueVisitorToken({ channelId: channel.id, ttlSeconds: 3600 }, ids.secret, new Date());
  ids.visitorToken = visitor.token;
  const received = await app.get(IngressService).receive(channel.id, { externalMessageId: 'wc-1', identityKind: 'webchat_visitor', identityValue: visitor.visitorId, alternateIdentities: [], profileName: 'Priya Deshmukh', receivedAt: new Date(), parts: [{ type: 'TEXT', text: 'SECRET-TRANSCRIPT my EMI was debited twice' }] }, 'test');
  if (received.status !== 'accepted') throw new Error('ingress failed');
  ids.conversation = received.conversationId;
  await db.db.update(conversations).set({ controlState: 'HUMAN_ACTIVE', assignedUserId: ids.exec!, lastPreview: 'SECRET-TRANSCRIPT' }).where(eq(conversations.id, ids.conversation));
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

describe('telemetry API (Tech admin only)', () => {
  it('serves the control center to tech admins', async () => {
    const overview = await http().get('/v1/telemetry/overview').set(auth(tokens.admin)).expect(200);
    expect(overview.body.status.chips.map((c: { key: string }) => c.key)).toEqual(['api', 'runtime', 'database', 'queue', 'providers', 'mcp', 'channels', 'webhooks']);
    expect(overview.body.tiles).toMatchObject({ activeConversations: 1, healthyWorkers: { healthy: 0, max: 10, minWarm: 2 } });
    expect(overview.body.queue.source).toBe('adapter');
    expect(overview.body.traceUrlTemplate).toBe('http://localhost:16686/trace/{traceId}');
    const latency = await http().get('/v1/telemetry/latency?minutes=30').set(auth(tokens.admin)).expect(200);
    expect(latency.body.points).toHaveLength(30);
    await http().get('/v1/telemetry/latency?minutes=2').set(auth(tokens.admin)).expect(400);
    for (const path of ['usage', 'workers', 'providers', 'mcp', 'changes?limit=5']) await http().get(`/v1/telemetry/${path}`).set(auth(tokens.admin)).expect(200);
    const changes = await http().get('/v1/telemetry/changes').set(auth(tokens.admin)).expect(200);
    expect(changes.body.changes.map((c: { action: string }) => c.action)).toContain('channel.create');
  });

  it('refuses leads, execs and anonymous callers', async () => {
    await http().get('/v1/telemetry/overview').set(auth(tokens.exec)).expect(403);
    await http().get('/v1/telemetry/workers').set(auth(tokens.lead)).expect(403);
    await http().get('/v1/telemetry/overview').expect(401);
  });
});

describe('analytics and home API', () => {
  it('serves agent analytics with formulas to leads only', async () => {
    const res = await http().get(`/v1/analytics/agents/${ids.agent}?days=7`).set(auth(tokens.lead)).expect(200);
    expect(res.body.tiles.conversations).toMatchObject({ value: 1, previous: 0, definition: expect.stringContaining('cohort') });
    expect(res.body.tiles.containmentRate.definition).toContain('no handoff');
    await http().get('/v1/analytics/agents').set(auth(tokens.lead)).expect(200);
    await http().get('/v1/analytics/overview?days=30').set(auth(tokens.lead)).expect(200);
    await http().get('/v1/analytics/queues').set(auth(tokens.lead)).expect(200);
    await http().get(`/v1/analytics/agents/${ids.agent}?days=500`).set(auth(tokens.lead)).expect(400);
    await http().get(`/v1/analytics/agents/${ids.agent}`).set(auth(tokens.admin)).expect(403);
    await http().get('/v1/analytics/agents').set(auth(tokens.exec)).expect(403);
  });

  it('returns one role surface per user and never leaks content to tech admins', async () => {
    const exec = await http().get('/v1/home').set(auth(tokens.exec)).expect(200);
    expect(exec.body.role).toBe('SERVICE');
    expect(exec.body.admin).toBeUndefined();
    expect(exec.body.exec.tiles.assignedToMe).toBe(1);
    expect(exec.body.exec.assigned[0]).toMatchObject({ customerName: 'Priya Deshmukh', controlState: 'HUMAN_ACTIVE' });
    const lead = await http().get('/v1/home').set(auth(tokens.lead)).expect(200);
    expect(lead.body.role).toBe('HEAD');
    expect(lead.body.lead.agents[0]).toMatchObject({ name: 'Maya', promptVersion: 1, conversations: 1 });
    const admin = await http().get('/v1/home').set(auth(tokens.admin)).expect(200);
    expect(admin.body.role).toBe('TECH');
    expect(admin.body.admin.tiles.activeConversations).toBe(1);
    const json = JSON.stringify(admin.body);
    expect(json).not.toContain('SECRET-TRANSCRIPT');
    expect(json).not.toContain('Priya');
    await http().get('/v1/home').expect(401);
  });
});

describe('quality API', () => {
  it('records reviews with an explicit rubric', async () => {
    const rubric = await http().get('/v1/reviews/rubric').set(auth(tokens.lead)).expect(200);
    expect(Object.keys(rubric.body.criteria)).toEqual(['accuracy', 'policy', 'tone', 'resolution']);
    const created = await http().post('/v1/reviews').set(auth(tokens.lead)).send({ conversationId: ids.conversation, rubric: { accuracy: 5, policy: 4, tone: 4, resolution: 4 }, outcomeTag: 'contained' }).expect(201);
    expect(created.body.score).toBe(4.25);
    await http().post('/v1/reviews').set(auth(tokens.lead)).send({ conversationId: ids.conversation, rubric: { accuracy: 0, policy: 4, tone: 4, resolution: 4 }, outcomeTag: 'x' }).expect(400);
    await http().post('/v1/reviews').set(auth(tokens.exec)).send({ conversationId: ids.conversation, rubric: { accuracy: 5, policy: 4, tone: 4, resolution: 4 }, outcomeTag: 'x' }).expect(403);
    const list = await http().get(`/v1/reviews?agentId=${ids.agent}`).set(auth(tokens.lead)).expect(200);
    expect(list.body).toHaveLength(1);
  });

  it('creates, stages and rejects prompt corrections', async () => {
    const created = await http().post('/v1/corrections').set(auth(tokens.lead)).send({ conversationId: ids.conversation, interactionSeq: 1, observed: 'asked for a statement', desired: 'check the ledger first', componentKey: 'behavior', proposedText: '• Check the ledger first.' }).expect(201);
    expect(created.body).toMatchObject({ merged: false });
    const staged = await http().post(`/v1/corrections/${created.body.id}/stage`).set(auth(tokens.lead)).send({}).expect(200);
    expect(staged.body).toEqual({ componentKey: 'behavior', changed: true });
    const other = await http().post('/v1/corrections').set(auth(tokens.lead)).send({ agentId: ids.agent, observed: 'too long', desired: 'shorter', componentKey: 'channel_constraints' }).expect(201);
    await http().post(`/v1/corrections/${other.body.id}/reject`).set(auth(tokens.lead)).send({ reason: 'duplicate' }).expect(204);
    await http().post(`/v1/corrections/${other.body.id}/reject`).set(auth(tokens.lead)).send({}).expect(409);
    const list = await http().get(`/v1/corrections?agentId=${ids.agent}`).set(auth(tokens.lead)).expect(200);
    expect(list.body.map((c: { status: string }) => c.status)).toEqual(['STAGED', 'REJECTED']);
    await http().post('/v1/corrections').set(auth(tokens.lead)).send({ observed: 'x', desired: 'y', componentKey: 'behavior' }).expect(400);
    await http().get('/v1/corrections').set(auth(tokens.admin)).expect(403);
  });

  it('queues replay evaluations on the configured queue', async () => {
    const run = await http().post('/v1/evaluations').set(auth(tokens.lead)).send({ agentId: ids.agent, caseCount: 5 }).expect(201);
    expect(run.body).toMatchObject({ status: 'QUEUED', caseCount: 5, summaryDefinition: expect.stringContaining('never executed') });
    expect(run.body.candidateComponents.behavior).toContain('Check the ledger first.'); // the staged draft
    const [job] = await db.db.select().from(jobs).where(eq(jobs.topic, 'evaluation.run'));
    expect(job!.payload).toEqual({ evaluationRunId: run.body.id });
    await http().get(`/v1/evaluations/${run.body.id}`).set(auth(tokens.lead)).expect(200);
    const results = await http().get(`/v1/evaluations/${run.body.id}/results?changedOnly=true`).set(auth(tokens.lead)).expect(200);
    expect(results.body).toEqual([]);
    await http().post('/v1/evaluations').set(auth(tokens.exec)).send({ agentId: ids.agent }).expect(403);
  });

  it('records staff CSAT with conversation access checks', async () => {
    const recorded = await http().post(`/v1/conversations/${ids.conversation}/csat`).set(auth(tokens.exec)).send({ score: 4 }).expect(201);
    expect(recorded.body).toMatchObject({ score: 4, handledByHuman: false });
    await http().post(`/v1/conversations/${ids.conversation}/csat`).set(auth(tokens.exec)).send({ score: 5 }).expect(409);
    await http().post(`/v1/conversations/${ids.conversation}/csat`).set(auth(tokens.admin)).send({ score: 5 }).expect(403);
    const list = await http().get(`/v1/conversations/${ids.conversation}/csat`).set(auth(tokens.lead)).expect(200);
    expect(list.body).toHaveLength(1);
  });

  it('accepts customer CSAT from the web-chat visitor for their own conversation', async () => {
    await db.db.update(conversations).set({ controlState: 'RESOLVED', resolvedAt: new Date() }).where(eq(conversations.id, ids.conversation!));
    const ok = await http().post(`/public/webchat/${ids.publicKey}/csat`).set(auth(ids.visitorToken!)).send({ score: 5, comment: 'quick' }).expect(201);
    expect(ok.body).toMatchObject({ recorded: true, score: 5 });
    await http().post(`/public/webchat/${ids.publicKey}/csat`).set(auth(ids.visitorToken!)).send({ score: 1 }).expect(409);
    await http().post(`/public/webchat/${ids.publicKey}/csat`).send({ score: 5 }).expect(401);
    await http().post(`/public/webchat/${ids.publicKey}/csat`).set(auth(ids.visitorToken!)).send({ score: 7 }).expect(400);
    const { issueVisitorToken } = await import('@ocso/channels');
    const stranger = issueVisitorToken({ channelId: ids.channel!, ttlSeconds: 3600 }, ids.secret!, new Date()).token;
    await http().post(`/public/webchat/${ids.publicKey}/csat`).set(auth(stranger)).send({ score: 5 }).expect(404);
    const [row] = await db.db.select({ csat: conversations.csatScore }).from(conversations).where(eq(conversations.id, ids.conversation!));
    expect(row!.csat).toBe(5);
  });
});
