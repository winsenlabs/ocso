import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Principal } from '@ocso/auth';
import { approvalDecisions, approvalProposals, approvalSecretRefs, auditEvents, channels, conversations, customers, users, uuidv7 } from '@ocso/db';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { MemoryQueue } from '@ocso/queue';
import { InMemorySecretRows, LocalSecretStore, parseMasterKey } from '@ocso/secrets';
import { ChannelService, IngressService, sweepApprovalSecrets, type ActorContext, type ChannelConfigValidator } from '../../src/index.js';
import { ensureUser, platformApprover, type PlatformApprover } from '../support/platform-approvals.js';

/**
 * Channels under maker–checker (PM/research/11 §4, approvals.check.channels): drafts are inert and edited
 * directly; ACTIVATE, DELETE and every change of an approved channel are proposals; a secret rotation travels
 * as a secret ref and never exposes the value; disabling is immediate and never locked by a proposal.
 */

const TOKEN = 'twilio-auth-token-VERY-SECRET-1234';
const ROTATED = 'twilio-auth-token-ROTATED-SECRET-9876';
/** A stand-in for the channel registry: `authToken` is required, `fail` in settings is invalid. */
const validate: ChannelConfigValidator = (_kind, settings, secrets) => [
  ...(secrets['authToken'] ? [] : ['authToken is required']),
  ...((settings as { fail?: boolean }).fail ? ['settings are invalid'] : []),
];

let t: TestDatabase;
let secrets: LocalSecretStore;
let rows: InMemorySecretRows;
let svc: ChannelService;
let approver: PlatformApprover;
const tech: Principal = { userId: uuidv7(), role: 'TECH', displayName: 'Tarun Tech', teamIds: [], via: 'UI' };
const as = (p: Principal): ActorContext => ({ principal: p, correlationId: `ch-${p.role}` });
const admin = as(tech);

beforeAll(async () => {
  t = await createTestDatabase();
  rows = new InMemorySecretRows();
  secrets = new LocalSecretStore(rows, parseMasterKey('k1', randomBytes(32).toString('base64')));
  svc = new ChannelService(t.db, secrets, validate, () => ({ webhookPath: null, embedPath: null }));
  await ensureUser(t.db, tech);
  approver = await platformApprover(t.db, { secrets, validateChannel: validate });
});
afterAll(async () => {
  await t?.drop();
});

const create = (name: string, over: Record<string, unknown> = {}) =>
  svc.create(admin, { kind: 'TWILIO_WHATSAPP', name, settings: { accountSid: 'AC1' }, secrets: { authToken: TOKEN }, status: 'DRAFT', ...over });

describe('channel drafts and activation', () => {
  it('creates a DRAFT (even when asked for ACTIVE) that ingress refuses; drafts are edited directly', async () => {
    const draft = await create('WA draft', { status: 'ACTIVE' });
    expect(draft.status).toBe('DRAFT');
    const ingress = new IngressService(t.db, new MemoryQueue());
    const message = { externalMessageId: uuidv7(), identityKind: 'whatsapp_phone', identityValue: '+919800000001', alternateIdentities: [], receivedAt: new Date(), parts: [{ type: 'TEXT' as const, text: 'hi' }] };
    expect(await ingress.receive(draft.id, message, 'c')).toEqual({ status: 'rejected', reason: 'channel_inactive' });
    expect((await svc.update(admin, draft.id, { name: 'WA draft 2', settings: { accountSid: 'AC2' } })).name).toBe('WA draft 2');
  });

  it('activation is an approval; the configuration is checked on save and again at activation; then every change is a proposal', async () => {
    await expect(create('WA invalid', { settings: { fail: true } })).rejects.toMatchObject({ code: 'invalid_channel_config' });
    const ch = await create('WA live');
    // A configuration that became invalid in the store (e.g. a secret removed out of band) is refused at activation.
    await t.db.update(channels).set({ secretRefs: {} }).where(eq(channels.id, ch.id));
    await expect(approver.submit(admin, 'channel', ch.id, 'ACTIVATE')).rejects.toMatchObject({
      code: 'validation_failed',
      details: { problems: [expect.objectContaining({ code: 'invalid_channel_config' })] },
    });
    await svc.update(admin, ch.id, { secrets: { authToken: TOKEN } });
    const proposal = await approver.approve(admin, 'channel', ch.id, 'ACTIVATE');
    expect(proposal).toMatchObject({ status: 'APPROVED', title: 'Activate channel WA live' });
    expect((await svc.get(ch.id)).status).toBe('ACTIVE');
    await expect(svc.update(admin, ch.id, { name: 'renamed' })).rejects.toMatchObject({ code: 'approval_required', details: { objectKind: 'channel', action: 'UPDATE' } });
    const [audit] = await t.db.select().from(auditEvents).where(eq(auditEvents.action, 'channel.activate'));
    expect(audit).toMatchObject({ targetId: ch.id, actorId: approver.checker.userId });
  });

  it('channel create/update audit rows keep auth settings (configuration), but still redact a raw token under auth', async () => {
    const auth = { mode: 'user', allowNativeApps: false, userToken: { verify: 'jwks', jwksUrl: 'https://idp.test/jwks' } };
    const ch = await create('WA auth settings', { settings: { accountSid: 'AC1', auth } });
    await svc.update(admin, ch.id, { settings: { accountSid: 'AC1', auth: { ...auth, allowNativeApps: true } } });
    const [created] = await t.db.select().from(auditEvents).where(and(eq(auditEvents.targetId, ch.id), eq(auditEvents.action, 'channel.create')));
    expect((created!.after as { settings: unknown }).settings).toEqual({ accountSid: 'AC1', auth });
    expect(JSON.stringify(created!.after)).not.toContain(TOKEN);
    const [updated] = await t.db.select().from(auditEvents).where(and(eq(auditEvents.targetId, ch.id), eq(auditEvents.action, 'channel.update')));
    expect((updated!.after as { settings: unknown }).settings).toEqual({ accountSid: 'AC1', auth: { ...auth, allowNativeApps: true } });
    expect((updated!.before as { settings: unknown }).settings).toEqual({ accountSid: 'AC1', auth });
    const raw = await create('WA raw auth', { settings: { accountSid: 'AC1', auth: 'Bearer raw-secret' } });
    const [rawRow] = await t.db.select().from(auditEvents).where(eq(auditEvents.targetId, raw.id));
    expect((rawRow!.after as { settings: unknown }).settings).toEqual({ accountSid: 'AC1', auth: '[REDACTED]' });
  });

  it('the maker cannot approve their own channel, nor bootstrap it while anyone holds approvals.check.channels', async () => {
    const ch = await create('WA self');
    await expect(approver.approvals.submit(admin, { objectKind: 'channel', objectId: ch.id, action: 'ACTIVATE', checkerId: tech.userId, reason: 'mine' })).rejects.toMatchObject({ code: 'checker_not_eligible' });
    await expect(approver.approvals.submit(admin, { objectKind: 'channel', objectId: ch.id, action: 'ACTIVATE', bootstrap: true, reason: 'mine' })).rejects.toMatchObject({ code: 'bootstrap_not_allowed' });
  });

  it('a sole Tech (nobody holds approvals.check.channels) bootstraps a channel with approvals.check.platform, recorded', async () => {
    const ch = await create('WA sole tech');
    // The only Head is away (disabled): nobody anywhere can check channels.
    await t.db.update(users).set({ status: 'DISABLED' }).where(eq(users.id, approver.checker.userId));
    try {
      const p = await approver.approvals.submit(admin, { objectKind: 'channel', objectId: ch.id, action: 'ACTIVATE', bootstrap: true, reason: 'First channel of a new deployment' });
      expect(p).toMatchObject({ status: 'APPROVED', bootstrap: true });
      expect((await svc.get(ch.id)).status).toBe('ACTIVE');
      const decisions = await t.db.select().from(approvalDecisions).where(eq(approvalDecisions.proposalId, p.id));
      expect(decisions.map((d) => d.kind)).toContain('BOOTSTRAP_APPROVE');
    } finally {
      await t.db.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, approver.checker.userId));
    }
  });
});

describe('secret rotation of an approved channel', () => {
  it('stages the new value as a new secret: the proposal, its snapshots, decisions and audit never carry it', async () => {
    const ch = await create('WA rotate');
    await approver.approve(admin, 'channel', ch.id, 'ACTIVATE');
    const oldRef = (await svc.get(ch.id)).secretRefs['authToken']!;
    const staged = await svc.stageChange(admin, ch.id, { secrets: { authToken: ROTATED } });
    expect(JSON.stringify(staged.payload)).not.toContain(ROTATED);
    const proposal = await approver.submit(admin, 'channel', ch.id, 'UPDATE', staged.payload as Record<string, unknown>);
    // The live channel still uses the old value until approval.
    expect(await secrets.resolve((await svc.get(ch.id)).secretRefs['authToken']!)).toBe(TOKEN);
    expect(proposal.after).toMatchObject({ credentials: { authToken: 'new value (proposed)' } });
    expect(JSON.stringify(proposal)).not.toMatch(new RegExp(`${TOKEN}|${ROTATED}`));
    const detail = await approver.approvals.get(approver.checker, proposal.id);
    expect(JSON.stringify(detail)).not.toMatch(new RegExp(`${TOKEN}|${ROTATED}`));

    await approver.decide(proposal);
    const after = await svc.get(ch.id);
    const newRef = after.secretRefs['authToken']!;
    expect(newRef).not.toBe(oldRef);
    expect(await secrets.resolve(newRef)).toBe(ROTATED);
    // The replaced value is released in the approval's transaction and deleted by the sweep after it commits.
    expect(await secrets.describe(oldRef)).not.toBeNull();
    await sweepApprovalSecrets(t.db, secrets);
    expect(await secrets.describe(oldRef)).toBeNull();
    expect(await secrets.resolve(newRef)).toBe(ROTATED);
    expect(await t.db.select().from(approvalSecretRefs).where(eq(approvalSecretRefs.ref, newRef))).toHaveLength(0);

    const [stored] = await t.db.select().from(approvalProposals).where(eq(approvalProposals.id, proposal.id));
    const decisions = await t.db.select().from(approvalDecisions).where(eq(approvalDecisions.proposalId, proposal.id));
    const audits = await t.db.select().from(auditEvents).where(eq(auditEvents.targetId, ch.id));
    for (const record of [stored, decisions, audits]) expect(JSON.stringify(record)).not.toMatch(new RegExp(`${TOKEN}|${ROTATED}`));
    expect(JSON.stringify(rows.raw(newRef))).not.toContain(ROTATED);
  });

  it('an invalid change is refused before any secret is staged; a submit that fails discards what it staged', async () => {
    const ch = await create('WA failing submit');
    await approver.approve(admin, 'channel', ch.id, 'ACTIVATE');
    const before = (await rows.list()).length;
    await expect(svc.stageChange(admin, ch.id, { secrets: { authToken: 'x-other-secret' }, settings: { fail: true } })).rejects.toMatchObject({ code: 'invalid_channel_config' });
    expect((await rows.list()).length).toBe(before);
    const staged = await svc.stageChange(admin, ch.id, { secrets: { authToken: 'x-other-secret' } });
    expect((await rows.list()).length).toBe(before + 1);
    // An open proposal locks the channel: this second submit fails (approval_open) and its staging is discarded.
    await approver.submit(admin, 'channel', ch.id, 'UPDATE', { name: 'WA failing submit 2' });
    await expect(approver.submit(admin, 'channel', ch.id, 'UPDATE', staged.payload as Record<string, unknown>)).rejects.toMatchObject({ code: 'approval_open' });
    await staged.discard();
    expect((await rows.list()).length).toBe(before);
  });
});

describe('secret refs a payload may carry', () => {
  it('refuses another object’s live credential ref, and a ref another maker staged', async () => {
    const victim = await create('WA victim');
    await approver.approve(admin, 'channel', victim.id, 'ACTIVATE');
    const borrowed = (await svc.get(victim.id)).secretRefs['authToken']!;
    const ch = await create('WA borrower');
    await approver.approve(admin, 'channel', ch.id, 'ACTIVATE');
    await expect(approver.submit(admin, 'channel', ch.id, 'UPDATE', { credentials: [{ field: 'authToken', ref: borrowed }] })).rejects.toMatchObject({
      code: 'validation_failed',
      details: { problems: [expect.objectContaining({ code: 'secret_ref_not_staged' })] },
    });
    // Staged for this channel, but by someone else: not this maker's value either.
    const other: Principal = { userId: uuidv7(), role: 'TECH', displayName: 'Other Tech', teamIds: [], via: 'UI' };
    await ensureUser(t.db, other);
    const staged = await svc.stageChange(as(other), ch.id, { secrets: { authToken: ROTATED } });
    await expect(approver.submit(admin, 'channel', ch.id, 'UPDATE', staged.payload as Record<string, unknown>)).rejects.toMatchObject({ details: { problems: [expect.objectContaining({ code: 'secret_ref_not_staged' })] } });
    await staged.discard();
    // The victim's credential is untouched.
    expect(await secrets.resolve(borrowed)).toBe(TOKEN);
  });

  it('the sweep deletes staged values of a withdrawn proposal and of a payload an edit replaced, never an open one', async () => {
    const ch = await create('WA orphans');
    await approver.approve(admin, 'channel', ch.id, 'ACTIVATE');
    const first = await svc.stageChange(admin, ch.id, { secrets: { authToken: 'first-staged-value' } });
    const proposal = await approver.submit(admin, 'channel', ch.id, 'UPDATE', first.payload as Record<string, unknown>);
    const firstRef = (first.payload.credentials ?? [])[0]!.ref;
    const second = await svc.stageChange(admin, ch.id, { secrets: { authToken: 'second-staged-value' } });
    const secondRef = (second.payload.credentials ?? [])[0]!.ref;
    await approver.approvals.edit(admin, proposal.id, { payload: second.payload as Record<string, unknown>, reason: 'Use the newer token' });
    expect(await sweepApprovalSecrets(t.db, secrets, { graceMs: 0 })).toMatchObject({ orphaned: 1 });
    expect(await secrets.describe(firstRef)).toBeNull();
    expect(await secrets.resolve(secondRef)).toBe('second-staged-value');
    await approver.approvals.withdraw(admin, proposal.id, 'Not needed after all');
    await sweepApprovalSecrets(t.db, secrets, { graceMs: 0 });
    expect(await secrets.describe(secondRef)).toBeNull();
    expect(await secrets.resolve((await svc.get(ch.id)).secretRefs['authToken']!)).toBe(TOKEN);
  });
});

describe('stop actions, resume and delete', () => {
  it('disabling is immediate even while a proposal is open, and does not void it; resuming is an ACTIVATE', async () => {
    const ch = await create('WA stop');
    await approver.approve(admin, 'channel', ch.id, 'ACTIVATE');
    const open = await approver.submit(admin, 'channel', ch.id, 'UPDATE', { name: 'WA stop renamed' });
    expect((await svc.disable(admin, ch.id)).status).toBe('DISABLED');
    expect(await approver.decide(open)).toMatchObject({ status: 'APPROVED' });
    expect((await svc.get(ch.id)).name).toBe('WA stop renamed');
    expect((await svc.get(ch.id)).status).toBe('DISABLED');
    const resume = await approver.approve(admin, 'channel', ch.id, 'ACTIVATE');
    expect(resume.title).toBe('Re-enable channel WA stop renamed');
    expect((await svc.get(ch.id)).status).toBe('ACTIVE');
  });

  it('delete is always a proposal: refused while active or with conversations on record; deletes secrets', async () => {
    const draft = await create('WA delete');
    await expect(approver.submit(admin, 'channel', draft.id, 'DELETE')).resolves.toMatchObject({ status: 'SUBMITTED' });
    const busy = await create('WA busy');
    await approver.approve(admin, 'channel', busy.id, 'ACTIVATE');
    await expect(approver.submit(admin, 'channel', busy.id, 'DELETE')).rejects.toMatchObject({ details: { problems: [expect.objectContaining({ code: 'channel_active' })] } });
    await svc.disable(admin, busy.id);
    const customerId = uuidv7();
    await t.db.insert(customers).values({ id: customerId, displayName: 'Priya' });
    await t.db.insert(conversations).values({ id: uuidv7(), customerId, channelId: busy.id, type: 'SUPPORT', controlState: 'ROUTING' });
    await expect(approver.submit(admin, 'channel', busy.id, 'DELETE')).rejects.toMatchObject({ details: { problems: [expect.objectContaining({ code: 'channel_has_history' })] } });

    const gone = await create('WA gone');
    const ref = gone.secretRefs['authToken']!;
    await approver.approve(admin, 'channel', gone.id, 'DELETE');
    expect(await t.db.select().from(channels).where(eq(channels.id, gone.id))).toHaveLength(0);
    await sweepApprovalSecrets(t.db, secrets);
    expect(await secrets.describe(ref)).toBeNull();
  });

  it('liveObjects lists ACTIVE channels only (drafts and disabled ones are not live)', async () => {
    const d = approver.approvals['registry'].get('channel');
    const live = await d.liveObjects(t.db);
    const all = await t.db.select({ id: channels.id, status: channels.status }).from(channels);
    expect(live.sort()).toEqual(all.filter((c) => c.status === 'ACTIVE').map((c) => c.id).sort());
  });
});
