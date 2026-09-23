import { eq } from 'drizzle-orm';
import { channels, mcpConnections, promptVersions, queues, tools, uuidv7, virtualAgents } from '@ocso/db';
import type { Principal } from '@ocso/auth';
import type { ApprovalAction, MessageTemplate, TemplateDraft } from '@ocso/domain';
import {
  ApprovalDecisionService,
  ApprovalService,
  createApprovalRegistry,
  createPassThroughRouter,
  systemActor,
  type ApprovalRegistry,
  type BusinessApprovalDeps,
  type ProposalDetail,
  type TemplateProviderPort,
} from '../../src/index.js';
import { act, createApprovalFixture, type ApprovalFixture } from './fixture.js';

/**
 * COVERAGE-BUSINESS test support over the approvals fixture: Maya taken live
 * through an approval, grantable MCP tools, a channel Maya is reached through
 * (so the Cards team's Lead and Heads manage its templates), and a recording
 * template provider standing in for the channel's adapter.
 */
export interface ProviderLog {
  created: TemplateDraft[];
  deleted: string[];
  /** Throw once from the next createTemplate AFTER recording it (a crash between the provider and our stamp). */
  crashAfterCreate: boolean;
  /** Refuse the next createTemplate (a provider review refusal). */
  refuseNext: boolean;
  /** Fail the next listTemplates (a provider outage while looking up an earlier submission). */
  listFailsNext?: boolean;
  templates: MessageTemplate[];
}

export interface BusinessFixture extends ApprovalFixture {
  business: { approvals: ApprovalService; decisions: ApprovalDecisionService; registry: ApprovalRegistry };
  providerLog: ProviderLog;
  channelId: string;
  toolIds: { search: string; reverse: string; lookup: string };
  worker: ReturnType<typeof systemActor>;
  goLive(agentId: string): Promise<void>;
  propose(maker: Principal, checker: Principal, target: { objectKind: string; objectId: string; action: ApprovalAction; payload?: Record<string, unknown> }): Promise<ProposalDetail>;
  approveNow(checker: Principal, id: string): Promise<ProposalDetail>;
}

export function templateOf(draft: TemplateDraft, id: string): MessageTemplate {
  return {
    id,
    name: draft.name,
    language: draft.language,
    category: draft.category,
    status: 'PENDING',
    rejectionReason: null,
    header: null,
    body: draft.body,
    footer: draft.footer,
    buttons: [],
    variables: [],
    placeholderScope: 'component',
    headerMediaRequired: false,
    contentType: null,
    unsupportedReason: null,
  };
}

export function recordingProvider(log: ProviderLog): TemplateProviderPort {
  return {
    listTemplates: async () => {
      if (log.listFailsNext) {
        log.listFailsNext = false;
        throw new Error('provider listing timed out');
      }
      return log.templates;
    },
    createTemplate: async (draft) => {
      if (log.refuseNext) {
        log.refuseNext = false;
        const { DomainError } = await import('@ocso/domain');
        throw new DomainError('validation', 'template_rejected_by_provider', 'Body contains a banned word');
      }
      log.created.push(draft);
      const created = templateOf(draft, `HX${uuidv7().replaceAll('-', '').slice(-12)}`);
      log.templates.push(created);
      if (log.crashAfterCreate) {
        log.crashAfterCreate = false;
        throw new Error('connection reset after the provider answered');
      }
      return created;
    },
    templateStatus: async (id) => log.templates.find((t) => t.id === id) ?? null,
    deleteTemplate: async (t) => {
      log.deleted.push(t.id);
      log.templates = log.templates.filter((x) => x.id !== t.id);
    },
  };
}

async function addTool(f: ApprovalFixture, connectionId: string, name: string): Promise<string> {
  const id = uuidv7();
  await f.t.db.insert(tools).values({
    id,
    connectionId,
    name,
    modelName: `bank__${name.replace('.', '_')}`,
    inputSchema: { type: 'object', properties: { amountMinor: { type: 'number' }, accountId: { type: 'string' } } },
    schemaHash: `h-${name}`,
    suggestedRisk: 'WRITE',
    riskClass: 'WRITE',
    approved: true,
  });
  return id;
}

export async function createBusinessFixture(): Promise<BusinessFixture> {
  const f = await createApprovalFixture();
  const provider: ProviderLog = { created: [], deleted: [], crashAfterCreate: false, refuseNext: false, templates: [] };
  const deps: BusinessApprovalDeps = { templateProviders: async () => recordingProvider(provider) };
  const registry = createApprovalRegistry({ business: deps });
  const business = { registry, approvals: new ApprovalService(f.t.db, registry), decisions: new ApprovalDecisionService(f.t.db, registry) };

  const connectionId = uuidv7();
  await f.t.db.insert(mcpConnections).values({ id: connectionId, name: 'Core banking', url: 'https://mcp.bank.test', status: 'ACTIVE', allowedAgentIds: ['*'], approvedAt: new Date() });
  const toolIds = { search: await addTool(f, connectionId, 'accounts.search'), reverse: await addTool(f, connectionId, 'payments.reverse'), lookup: await addTool(f, connectionId, 'cards.lookup') };

  // A channel that reaches Maya through a pass-through router, so the Cards team manages its templates.
  const queueId = uuidv7();
  await f.t.db.insert(queues).values({ id: queueId, name: 'Cards service', agentId: f.maya });
  const channelId = uuidv7();
  await f.t.db.insert(channels).values({ id: channelId, kind: 'WHATSAPP', name: 'WhatsApp — Twilio', status: 'ACTIVE', publicKey: `pk-${channelId.slice(-8)}` });
  await createPassThroughRouter(f.t.db, act(f.p.head), { name: 'WhatsApp — Twilio', queueId, channelIds: [channelId] });

  const propose: BusinessFixture['propose'] = (maker, checker, target) =>
    business.approvals.submit(act(maker), { ...target, checkerId: checker.userId, reason: 'Needed for customers' });
  const approveNow: BusinessFixture['approveNow'] = async (checker, id) => {
    const shown = await business.approvals.get(checker, id);
    return business.decisions.decide(act(checker), id, { decision: 'APPROVE', reason: 'Checked', contentHash: shown.contentHash, dependencyHash: shown.dependencyHash });
  };
  return {
    ...f,
    business,
    providerLog: provider,
    channelId,
    toolIds,
    worker: systemActor('approval-activation', 'business-test', 'Approval activation'),
    propose,
    approveNow,
    async goLive(agentId) {
      const [agent] = await f.t.db.select({ status: virtualAgents.status, prompt: virtualAgents.activePromptVersionId }).from(virtualAgents).where(eq(virtualAgents.id, agentId));
      if (agent?.status === 'LIVE') return;
      if (!agent?.prompt) {
        const [v] = await f.t.db.select({ id: promptVersions.id }).from(promptVersions).where(eq(promptVersions.agentId, agentId));
        await f.t.db.update(virtualAgents).set({ activePromptVersionId: v!.id }).where(eq(virtualAgents.id, agentId));
      }
      const p = await propose(f.p.lead, f.p.head, { objectKind: 'agent', objectId: agentId, action: 'ACTIVATE' });
      await approveNow(f.p.head, p.id);
    },
  };
}
