import { generateSigningKeyPem, loadSigningKey, type AuditSigner } from '@ocso/audit-store';
import {
  approvalDecisions,
  approvalProposals,
  auditEvents,
  auditIncidents,
  auditVerifications,
  channels,
  conversationRouting,
  conversations,
  customers,
  interactionParts,
  interactions,
  messageTemplates,
  queueTeams,
  queues,
  routers,
  userPermissionGrants,
  uuidv7,
  virtualAgents,
  webhookDeliveries,
  webhookSubscriptions,
} from '@ocso/db';
import type { Principal } from '@ocso/auth';
import { eq } from 'drizzle-orm';
import { ExceptionService, recordAudit } from '../../src/index.js';
import { act, createApprovalFixture, type ApprovalFixture } from '../approvals/fixture.js';

/**
 * Exception-report fixture: the approvals fixture (two teams, Heads, a Lead,
 * a Tech admin, draft agent Maya) plus an ExceptionService with a fresh audit
 * signing key and helpers that seed one occurrence of each exception kind.
 */
export interface ExceptionFixture extends ApprovalFixture {
  signer: AuditSigner;
  service: ExceptionService;
  now: { value: Date };
  seed: {
    liveAgentWithoutApproval(name: string): Promise<string>;
    agedProposal(maker: Principal, checker: Principal, hoursAgo: number): Promise<string>;
    bootstrap(maker: Principal, at: Date): Promise<string>;
    grantWithoutApproval(user: Principal, permission: string): Promise<string>;
    skippedApprovalAudit(user: Principal): Promise<void>;
    routing(at: Date, outcome: 'FALLBACK' | 'TIMEOUT' | 'RULE', queueTeam: string | null): Promise<{ routerId: string; queueId: string; conversationId: string }>;
    rejectedTemplate(at: Date): Promise<string>;
    failedDeliveries(at: Date): Promise<{ channelId: string; subscriptionId: string }>;
    auditIncident(kind: 'SHIP_FAILED' | 'CHAIN_BROKEN', firstSeen: Date, resolvedAt: Date | null): Promise<string>;
    unshippedAudit(at: Date): Promise<void>;
    failedVerification(at: Date): Promise<string>;
  };
}

export async function createExceptionFixture(now = new Date()): Promise<ExceptionFixture> {
  const f = await createApprovalFixture();
  // Setup is complete: weekly reports are generated only after it.
  await f.t.pool.query(`UPDATE deployment_settings SET setup_completed_at = $1`, [new Date(now.getTime() - 60 * 86_400_000)]);
  const signer = loadSigningKey(generateSigningKeyPem());
  const clock = { value: now };
  const service = new ExceptionService(f.t.db, f.registry, { signer, now: () => clock.value });
  const db = f.t.db;

  const proposal = async (maker: Principal, checker: Principal, submittedAt: Date, objectId = uuidv7()) => {
    const id = uuidv7();
    await db.insert(approvalProposals).values({
      id,
      objectKind: 'agent',
      objectId,
      action: 'UPDATE',
      payload: { name: 'x' },
      contentHash: 'ap_test',
      dependencyHash: 'ad_test',
      teamIds: [f.team.cards],
      title: 'Change Maya: name',
      reason: 'Seeded for the exception report',
      makerId: maker.userId,
      checkerId: checker.userId,
      submittedAt,
    });
    return id;
  };

  let channelSeq = 0;
  const channel = async () => {
    const id = uuidv7();
    await db.insert(channels).values({ id, kind: 'WHATSAPP', name: `WhatsApp ${++channelSeq}`, status: 'DISABLED', publicKey: `pk-exc-${id}` });
    return id;
  };

  const seed: ExceptionFixture['seed'] = {
    async liveAgentWithoutApproval(name) {
      const id = await f.newAgent(name);
      await db.update(virtualAgents).set({ status: 'LIVE' }).where(eq(virtualAgents.id, id));
      return id;
    },
    agedProposal: (maker, checker, hoursAgo) => proposal(maker, checker, new Date(clock.value.getTime() - hoursAgo * 3_600_000)),
    async bootstrap(maker, at) {
      const id = await proposal(maker, f.p.head2, at);
      await db.insert(approvalDecisions).values({ id: uuidv7(), proposalId: id, revision: 1, kind: 'BOOTSTRAP_APPROVE', actorId: maker.userId, actorName: maker.displayName, reason: 'Only checker', contentHash: 'ap_test', occurredAt: at });
      return id;
    },
    async grantWithoutApproval(user, permission) {
      const id = uuidv7();
      await db.insert(userPermissionGrants).values({ id, userId: user.userId, permission, effect: 'GRANT', reason: 'Granted directly', createdBy: f.p.tech.userId });
      return id;
    },
    async skippedApprovalAudit(user) {
      await db.transaction((tx) =>
        recordAudit(tx, act(f.p.tech), { action: 'user.permissions_changed', targetType: 'user', targetId: user.userId, summary: `Granted rights to ${user.displayName}`, after: { approvalSkipped: 'dev_flag' } }),
      );
    },
    async routing(at, outcome, queueTeam) {
      const routerId = uuidv7();
      const queueId = uuidv7();
      const customerId = uuidv7();
      const conversationId = uuidv7();
      const channelId = await channel();
      await db.insert(routers).values({ id: routerId, name: `Router ${routerId.slice(-4)}`, description: '', status: 'DRAFT' });
      await db.insert(queues).values({ id: queueId, name: `Queue ${queueId.slice(-4)}` });
      if (queueTeam) await db.insert(queueTeams).values({ queueId, teamId: queueTeam });
      await db.insert(customers).values({ id: customerId, displayName: 'Customer' });
      await db.insert(conversations).values({ id: conversationId, customerId, agentId: f.maya, channelId, type: 'SUPPORT', controlState: 'AI_ACTIVE', queueId, openedAt: at, lastInteractionAt: at });
      await db.insert(conversationRouting).values({ conversationId, routerId, phase: 'DONE', outcome, queueId, decidedAt: at });
      // The routing decision on the timeline (the history the check reads), a routing-blocked entry and a refused customer message.
      const routed = uuidv7();
      await db.insert(interactions).values({ id: routed, conversationId, seq: 1, actorType: 'SYSTEM', direction: 'INTERNAL', visibility: 'INTERNAL', kind: 'SYSTEM_EVENT', correlationId: 'seed', createdAt: at });
      await db
        .insert(interactionParts)
        .values({ id: uuidv7(), interactionId: routed, idx: 0, type: 'STRUCTURED', content: { type: 'STRUCTURED', schema: 'system.routed', data: { routerId, queueId, outcome, ruleIndex: null }, fallbackText: 'routed' } });
      const iid = uuidv7();
      await db.insert(interactions).values({ id: iid, conversationId, seq: 2, actorType: 'SYSTEM', direction: 'INTERNAL', visibility: 'INTERNAL', kind: 'SYSTEM_EVENT', correlationId: 'seed', createdAt: at });
      await db.insert(interactionParts).values({ id: uuidv7(), interactionId: iid, idx: 0, type: 'STRUCTURED', content: { type: 'STRUCTURED', schema: 'system.routing_blocked', data: { routerId }, fallbackText: 'blocked' } });
      await db.insert(auditEvents).values({ id: uuidv7(), occurredAt: at, actorType: 'SYSTEM', via: 'SYSTEM', action: 'conversation.inbound_rejected', targetType: 'channel', targetId: channelId, summary: 'refused', after: { reason: 'no_router' } });
      return { routerId, queueId, conversationId };
    },
    async rejectedTemplate(at) {
      const id = uuidv7();
      await db.insert(messageTemplates).values({ id, channelId: await channel(), providerTemplateId: `HX${id.slice(-8)}`, name: 'card_blocked', language: 'en', category: 'UTILITY', status: 'REJECTED', rejectionReason: 'INVALID_FORMAT', definition: {}, statusChangedAt: at });
      // The provider's verdict as the status poller audits it (the history a report reads).
      await db.insert(auditEvents).values({
        id: uuidv7(),
        occurredAt: at,
        actorType: 'SYSTEM',
        via: 'SYSTEM',
        action: 'message_template.status_changed',
        targetType: 'message_template',
        targetId: id,
        summary: 'Message template card_blocked (en): PENDING → REJECTED',
        before: { status: 'PENDING' },
        after: { status: 'REJECTED', rejectionReason: 'INVALID_FORMAT' },
      });
      return id;
    },
    async failedDeliveries(at) {
      const channelId = await channel();
      const customerId = uuidv7();
      const conversationId = uuidv7();
      await db.insert(customers).values({ id: customerId, displayName: 'Customer' });
      await db.insert(conversations).values({ id: conversationId, customerId, agentId: f.maya, channelId, type: 'SUPPORT', controlState: 'AI_ACTIVE', openedAt: at, lastInteractionAt: at });
      for (const seq of [1, 2]) {
        await db.insert(interactions).values({ id: uuidv7(), conversationId, channelId, seq, actorType: 'AGENT', direction: 'OUTBOUND', visibility: 'CUSTOMER', correlationId: 'seed', deliveryStatus: 'FAILED', deliveryError: 'session_window_closed', createdAt: at });
      }
      const subscriptionId = uuidv7();
      await db.insert(webhookSubscriptions).values({ id: subscriptionId, name: 'CRM sync', url: 'https://crm.example/hook', events: ['conversation.resolved'], signingSecretRef: 'secret://whsec' });
      await db.insert(webhookDeliveries).values({ id: uuidv7(), subscriptionId, eventId: uuidv7(), eventType: 'conversation.resolved', status: 'FAILED', attempts: 5, lastError: 'HTTP 500', createdAt: at });
      return { channelId, subscriptionId };
    },
    async auditIncident(kind, firstSeen, resolvedAt) {
      const id = uuidv7();
      await db.insert(auditIncidents).values({ id, kind, detail: kind === 'CHAIN_BROKEN' ? { firstBrokenAt: 10, lastBrokenAt: 12 } : {}, firstSeen, lastSeen: firstSeen, count: 3, resolvedAt });
      return id;
    },
    async unshippedAudit(at) {
      await db.insert(auditEvents).values({ id: uuidv7(), occurredAt: at, actorType: 'SYSTEM', via: 'SYSTEM', action: 'test.waiting', targetType: 'deployment', summary: 'waiting to ship' });
    },
    async failedVerification(at) {
      const id = uuidv7();
      await db.insert(auditVerifications).values({ id, startedAt: at, updatedAt: at, finishedAt: at, headAtStart: 20, checkedTo: 20, entries: 20, ok: false, problems: [{ kind: 'HASH_MISMATCH', position: 11 }] });
      return id;
    },
  };
  return { ...f, signer, service, now: clock, seed };
}
