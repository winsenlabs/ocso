import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Principal } from '@ocso/auth';
import { approvalDecisions, authPolicy, deploymentSettings, modelProfiles, modelProviders, userPermissionGrants, users, uuidv7, workerSettings } from '@ocso/db';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { createDefaultRegistry } from '@ocso/model-providers';
import {
  ApprovalService,
  AuthPolicyService,
  SETTINGS_OBJECT_ID,
  SettingsService,
  createApprovalRegistry,
  sectionsOfDeploymentInput,
  type ActorContext,
} from '../../src/index.js';
import { ensureUser, platformApprover, type PlatformApprover } from '../support/platform-approvals.js';

/**
 * The deployment settings under maker–checker (PM/research/11 §4): one descriptor on the singleton, every
 * section a proposal, retention below the audit floor refused at submit, worker settings need
 * system.configure, one open settings proposal at a time, and a sole Tech bootstraps (recorded).
 */

let t: TestDatabase;
let approver: PlatformApprover;
const tech: Principal = { userId: uuidv7(), role: 'TECH', displayName: 'Tarun Tech', teamIds: [], via: 'UI' };
const admin: ActorContext = { principal: tech, correlationId: 'settings-test' };
const row = async () => (await t.db.select().from(deploymentSettings).where(eq(deploymentSettings.id, 1)))[0]!;

beforeAll(async () => {
  t = await createTestDatabase();
  await ensureUser(t.db, tech);
  approver = await platformApprover(t.db);
});
afterAll(async () => {
  await t?.drop();
});

describe('deployment settings proposals', () => {
  it('the direct paths answer approval_required: settings are always live', async () => {
    await expect(new SettingsService(t.db).updateDeployment(admin, { orgName: 'Meridian' })).rejects.toMatchObject({ code: 'approval_required', details: { objectKind: 'deployment_settings', objectId: SETTINGS_OBJECT_ID } });
    await expect(new AuthPolicyService(t.db).update(admin, { requireMfaRoles: ['TECH'] })).rejects.toMatchObject({ code: 'approval_required' });
    const gate = await approver.approvals.gate(tech, 'deployment_settings', SETTINGS_OBJECT_ID, 'UPDATE');
    expect(gate).toEqual({ needed: true, openId: null });
  });

  it('applies several sections in one approval, each with its own audit row', async () => {
    const change = { ...sectionsOfDeploymentInput({ orgName: 'Meridian Bank', execsCanViewAiActive: false, approvalAgeWarningHours: 48, auditLocalWindowDays: 120 }), workers: { maxWorkers: 12 }, mfa: { requireMfaRoles: ['TECH' as const, 'HEAD' as const] } };
    expect(Object.keys(change).sort()).toEqual(['approvals', 'audit', 'deployment', 'mfa', 'visibility', 'workers']);
    const proposal = await approver.submit(admin, 'deployment_settings', SETTINGS_OBJECT_ID, 'UPDATE', change);
    expect(proposal.title).toMatch(/^Change deployment, visibility, workers, mfa, approvals, audit settings/);
    expect(proposal.changedFields).toEqual(expect.arrayContaining(['deployment.orgName', 'visibility.execsCanViewAiActive', 'workers.maxWorkers', 'mfa.requireMfaRoles']));
    // Nothing changes until the checker approves.
    expect((await row()).orgName).toBe('My organization');
    await approver.decide(proposal);
    expect(await row()).toMatchObject({ orgName: 'Meridian Bank', execsCanViewAiActive: false, approvalAgeWarningHours: 48, auditLocalWindowDays: 120 });
    expect((await t.db.select().from(workerSettings))[0]!.maxWorkers).toBe(12);
    expect((await t.db.select().from(authPolicy))[0]!.requireMfaRoles.sort()).toEqual(['HEAD', 'TECH']);
  });

  it('refuses a retention below the audit floor at submit', async () => {
    await expect(approver.submit(admin, 'deployment_settings', SETTINGS_OBJECT_ID, 'UPDATE', { retention: { auditEvents: 30 } })).rejects.toMatchObject({ code: 'invalid_payload' });
    const ok = await approver.approve(admin, 'deployment_settings', SETTINGS_OBJECT_ID, 'UPDATE', { retention: { conversationContent: 30, auditEvents: 400 } });
    expect(ok.status).toBe('APPROVED');
    expect((await row()).retention).toMatchObject({ conversationContent: 30, auditEvents: 400 });
  });

  it('worker settings are validated as a whole and need system.configure from the maker', async () => {
    await expect(approver.submit(admin, 'deployment_settings', SETTINGS_OBJECT_ID, 'UPDATE', { workers: { minWarmWorkers: 40 } })).rejects.toMatchObject({
      code: 'validation_failed',
      details: { problems: [expect.objectContaining({ code: 'invalid_worker_settings' })] },
    });
    const grantedDeploymentOnly: Principal = { userId: uuidv7(), role: 'LEAD', displayName: 'Lina', teamIds: [], via: 'UI', permissions: new Set(['deployment_settings.manage'] as never) };
    await ensureUser(t.db, grantedDeploymentOnly);
    await t.db.insert(userPermissionGrants).values({ id: uuidv7(), userId: grantedDeploymentOnly.userId, permission: 'deployment_settings.manage', effect: 'GRANT', reason: 'test', createdBy: tech.userId });
    await expect(approver.submit({ principal: grantedDeploymentOnly, correlationId: 'x' }, 'deployment_settings', SETTINGS_OBJECT_ID, 'UPDATE', { workers: { maxWorkers: 9 } })).rejects.toMatchObject({
      details: { problems: [expect.objectContaining({ code: 'workers_not_permitted' })] },
    });
  });

  it('a system.configure holder proposes worker settings only; other sections need deployment_settings.manage', async () => {
    const ops: Principal = { userId: uuidv7(), role: 'LEAD', displayName: 'Omar Ops', teamIds: [], via: 'UI' };
    await ensureUser(t.db, ops);
    for (const permission of ['system.configure', 'approvals.read']) {
      await t.db.insert(userPermissionGrants).values({ id: uuidv7(), userId: ops.userId, permission, effect: 'GRANT', reason: 'test', createdBy: tech.userId });
    }
    const actor: ActorContext = { principal: { ...ops, permissions: new Set(['system.configure', 'approvals.read'] as never) }, correlationId: 'ops' };
    await expect(approver.submit(actor, 'deployment_settings', SETTINGS_OBJECT_ID, 'UPDATE', { deployment: { orgName: 'Ops Bank' } })).rejects.toMatchObject({
      details: { problems: [expect.objectContaining({ code: 'settings_not_permitted' })] },
    });
    const workers = await approver.submit(actor, 'deployment_settings', SETTINGS_OBJECT_ID, 'UPDATE', { workers: { maxWorkers: 11 } });
    await approver.approvals.withdraw(actor, workers.id, 'Only checking the rights');
  });

  it('the internal agent may only use a model profile a platform checker approved', async () => {
    const providerId = uuidv7();
    const profileId = uuidv7();
    await t.db.insert(modelProviders).values({ id: providerId, kind: 'DEV_SCRIPTED', name: 'Scripted IA', enabled: true });
    await t.db.insert(modelProfiles).values({ id: profileId, name: 'ia-unreviewed', providerId, model: 'scripted-1' });
    await expect(approver.submit(admin, 'deployment_settings', SETTINGS_OBJECT_ID, 'UPDATE', { deployment: { internalAgentProfileId: profileId } })).rejects.toMatchObject({
      details: { problems: [expect.objectContaining({ code: 'model_profile_not_approved' })] },
    });
    await (await platformApprover(t.db, { providers: createDefaultRegistry({ enableDevProviders: true }) })).approve(admin, 'model_profile', profileId, 'ACTIVATE');
    expect((await approver.approve(admin, 'deployment_settings', SETTINGS_OBJECT_ID, 'UPDATE', { deployment: { internalAgentProfileId: profileId } })).status).toBe('APPROVED');
  });

  it('one settings proposal is open at a time; the maker edits it to add a section', async () => {
    const open = await approver.submit(admin, 'deployment_settings', SETTINGS_OBJECT_ID, 'UPDATE', { deployment: { timezone: 'Asia/Kolkata' } });
    await expect(approver.submit(admin, 'deployment_settings', SETTINGS_OBJECT_ID, 'UPDATE', { visibility: { execsCanViewAiActive: true } })).rejects.toMatchObject({ code: 'approval_open' });
    const edited = await approver.approvals.edit(admin, open.id, { payload: { deployment: { timezone: 'Asia/Kolkata' }, visibility: { execsCanViewAiActive: true } } });
    expect(edited.revision).toBe(2);
    await approver.decide(edited);
    expect(await row()).toMatchObject({ timezone: 'Asia/Kolkata', execsCanViewAiActive: true });
  });
});

describe('a deployment with one Tech and nobody else who can check', () => {
  it('bootstraps (self-approval, recorded as BOOTSTRAP_APPROVE); refused as soon as another checker exists', async () => {
    const solo = await createTestDatabase();
    try {
      const only: Principal = { userId: uuidv7(), role: 'TECH', displayName: 'Only Tech', teamIds: [], via: 'UI' };
      await solo.db.insert(users).values({ id: only.userId, email: 'only@x.test', name: 'Only Tech', role: 'TECH' });
      const registry = createApprovalRegistry();
      const approvals = new ApprovalService(solo.db, registry);
      const actor = { principal: only, correlationId: 'solo' };
      const done = await approvals.submit(actor, { objectKind: 'deployment_settings', objectId: SETTINGS_OBJECT_ID, action: 'UPDATE', bootstrap: true, reason: 'Only Tech', payload: { deployment: { orgName: 'Solo Bank' } } });
      expect(done).toMatchObject({ status: 'APPROVED', bootstrap: true });
      expect((await solo.db.select().from(deploymentSettings))[0]!.orgName).toBe('Solo Bank');
      const kinds = (await solo.db.select({ kind: approvalDecisions.kind }).from(approvalDecisions).where(eq(approvalDecisions.proposalId, done.id))).map((d) => d.kind);
      expect(kinds).toContain('BOOTSTRAP_APPROVE');
      // A Head arrives: bootstrap is no longer allowed; the Head is the checker.
      await solo.db.insert(users).values({ id: uuidv7(), email: 'head@x.test', name: 'Head', role: 'HEAD' });
      await expect(approvals.submit(actor, { objectKind: 'deployment_settings', objectId: SETTINGS_OBJECT_ID, action: 'UPDATE', bootstrap: true, reason: 'Only Tech?', payload: { deployment: { orgName: 'Solo Bank 2' } } })).rejects.toMatchObject({ code: 'bootstrap_not_allowed' });
    } finally {
      await solo.drop();
    }
  });
});
