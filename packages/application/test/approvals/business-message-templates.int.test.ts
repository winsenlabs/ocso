import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvalProposals, messageTemplates } from '@ocso/db';
import { MessageTemplateService, TEMPLATE_KIND } from '../../src/index.js';
import { createBusinessFixture, recordingProvider, templateOf, type BusinessFixture } from './business-fixture.js';
import { act } from './fixture.js';

/**
 * message_template (PM/research/11 §4, 11b): drafts stay in OCSO and are never
 * sent; submitting one is a CREATE proposal whose DEFERRED activation calls the
 * provider — never before approval and never twice; deleting (Head) is a DELETE
 * proposal finished at the provider by the worker.
 */
let f: BusinessFixture;
let templates: MessageTemplateService;
const draft = (name: string) => ({ name, language: 'en', category: 'UTILITY' as const, body: 'Hi {{1}}, your card ending {{2}} is ready.', examples: { '1': 'Priya', '2': '4242' } });

beforeAll(async () => {
  f = await createBusinessFixture();
  templates = new MessageTemplateService(f.t.db, async () => recordingProvider(f.providerLog));
});
afterAll(async () => {
  await f?.t.drop();
});
beforeEach(() => {
  f.providerLog.created = [];
  f.providerLog.deleted = [];
});

const row = async (id: string) => (await f.t.db.select().from(messageTemplates).where(eq(messageTemplates.id, id)))[0]!;
const submit = (recordId: string) => f.propose(f.p.lead, f.p.head, { objectKind: TEMPLATE_KIND, objectId: recordId, action: 'CREATE' });

describe('message templates under maker–checker', () => {
  it('a draft is saved in OCSO only, listed as a draft and edited freely', async () => {
    const { template, problems } = await templates.createDraft(act(f.p.lead), f.channelId, draft('card_ready'));
    expect(problems).toEqual([]);
    expect(template).toMatchObject({ status: 'DRAFT', submission: { draft: true, approval: null } });
    expect(f.providerLog.created).toEqual([]);
    const recordId = template.submission!.recordId;
    await templates.updateDraft(act(f.p.lead), f.channelId, recordId, { ...draft('card_ready'), body: 'Hello {{1}}, card {{2}} is ready.' });
    const listed = (await templates.list(f.channelId)).templates.find((t) => t.id === recordId);
    expect(listed).toMatchObject({ status: 'DRAFT', body: 'Hello {{1}}, card {{2}} is ready.' });
  });

  it('submitting is a proposal; nothing reaches the provider before approval, and it is created exactly once', async () => {
    const recordId = (await templates.createDraft(act(f.p.lead), f.channelId, draft('emi_due'))).template.submission!.recordId;
    const p = await submit(recordId);
    expect(p.title).toBe('Submit template emi_due (en) to WhatsApp — Twilio');
    // The checker sees everything that goes to the provider as the change.
    expect(p.diff.map((d) => d.path)).toEqual(expect.arrayContaining(['body', 'examples', 'status']));
    // Locked while it waits for the checker; the provider has not been called.
    await expect(templates.updateDraft(act(f.p.lead), f.channelId, recordId, draft('emi_due'))).rejects.toMatchObject({ code: 'approval_open' });
    expect((await templates.list(f.channelId)).templates.find((t) => t.id === recordId)!.submission!.approval).toMatchObject({ action: 'CREATE', activating: false });
    expect(f.providerLog.created).toEqual([]);
    const approved = await f.approveNow(f.p.head, p.id);
    expect(approved).toMatchObject({ status: 'APPROVED', activating: true });
    expect(f.providerLog.created).toEqual([]); // deferred: the worker makes the call
    expect(await f.business.decisions.finishActivation(f.worker, p.id)).toBe('ACTIVATED');
    expect(await f.business.decisions.finishActivation(f.worker, p.id)).toBe('SKIPPED');
    expect(f.providerLog.created.map((d) => d.name)).toEqual(['emi_due']);
    expect(await row(recordId)).toMatchObject({ status: 'PENDING', providerTemplateId: expect.stringMatching(/^HX/) });
    // Once at the provider it is no longer a draft.
    await expect(templates.updateDraft(act(f.p.lead), f.channelId, recordId, draft('emi_due'))).rejects.toMatchObject({ code: 'template_submitted' });
  });

  it('a crash after the provider answered never creates it twice on retry', async () => {
    const recordId = (await templates.createDraft(act(f.p.lead), f.channelId, draft('otp_help'))).template.submission!.recordId;
    const p = await submit(recordId);
    await f.approveNow(f.p.head, p.id);
    f.providerLog.crashAfterCreate = true;
    await expect(f.business.decisions.finishActivation(f.worker, p.id)).rejects.toThrow(/connection reset/);
    expect(await f.business.decisions.finishActivation(f.worker, p.id)).toBe('ACTIVATED');
    expect(f.providerLog.created.map((d) => d.name)).toEqual(['otp_help']);
    expect((await row(recordId)).providerTemplateId).toBe(f.providerLog.templates.find((t) => t.name === 'otp_help')!.id);
  });

  it('a listing that fails is retried, never answered with a second create', async () => {
    const recordId = (await templates.createDraft(act(f.p.lead), f.channelId, draft('limit_raised'))).template.submission!.recordId;
    const p = await submit(recordId);
    await f.approveNow(f.p.head, p.id);
    f.providerLog.listFailsNext = true;
    await expect(f.business.decisions.finishActivation(f.worker, p.id)).rejects.toMatchObject({ code: 'template_lookup_failed', retriable: true });
    expect(f.providerLog.created).toEqual([]);
    expect(await f.business.decisions.finishActivation(f.worker, p.id)).toBe('ACTIVATED');
    expect(f.providerLog.created.map((d) => d.name)).toEqual(['limit_raised']);
  });

  it('a console template with the same name and other content is not adopted: the proposal blocks', async () => {
    f.providerLog.templates.push({ ...templateOf({ ...draft('kyc_reminder'), body: 'Click here to win {{1}}', allowCategoryChange: true, header: null, footer: null, buttons: [], authentication: null }, 'HX_CONSOLE_KYC'), status: 'APPROVED' });
    const recordId = (await templates.createDraft(act(f.p.lead), f.channelId, draft('kyc_reminder'))).template.submission!.recordId;
    const p = await submit(recordId);
    await f.approveNow(f.p.head, p.id);
    expect(await f.business.decisions.finishActivation(f.worker, p.id)).toBe('BLOCKED');
    expect(f.providerLog.created).toEqual([]);
    expect(await row(recordId)).toMatchObject({ status: 'DRAFT', providerTemplateId: null });
    const [blocked] = await f.t.db.select().from(approvalProposals).where(eq(approvalProposals.id, p.id));
    expect(blocked!.blockedReason).toMatch(/other content/);
  });

  it('a crash after the provider deletion committed finishes ACTIVATED on retry, never BLOCKED', async () => {
    const recordId = (await templates.createDraft(act(f.p.lead), f.channelId, draft('crash_delete'))).template.submission!.recordId;
    const create = await submit(recordId);
    await f.approveNow(f.p.head, create.id);
    await f.business.decisions.finishActivation(f.worker, create.id);
    const del = await f.propose(f.p.head, f.p.head2, { objectKind: TEMPLATE_KIND, objectId: recordId, action: 'DELETE' });
    await f.approveNow(f.p.head2, del.id);
    // The worker deleted it and recorded that, then died before stamping the proposal.
    await f.t.db.update(messageTemplates).set({ deletedAt: new Date() }).where(eq(messageTemplates.id, recordId));
    expect(await f.business.decisions.finishActivation(f.worker, del.id)).toBe('ACTIVATED');
    expect(f.providerLog.deleted).toEqual([]);
  });

  it('a provider refusal blocks the proposal and leaves the draft a draft', async () => {
    const recordId = (await templates.createDraft(act(f.p.lead), f.channelId, draft('promo_blast'))).template.submission!.recordId;
    const p = await submit(recordId);
    await f.approveNow(f.p.head, p.id);
    f.providerLog.refuseNext = true;
    expect(await f.business.decisions.finishActivation(f.worker, p.id)).toBe('BLOCKED');
    expect(await row(recordId)).toMatchObject({ status: 'DRAFT', providerTemplateId: null });
    const [blocked] = await f.t.db.select().from(approvalProposals).where(eq(approvalProposals.id, p.id));
    expect(blocked!.blockedReason).toMatch(/banned word/);
  });

  it('deleting needs message_templates.delete (Head) and is finished at the provider once', async () => {
    const recordId = (await templates.createDraft(act(f.p.lead), f.channelId, draft('old_notice'))).template.submission!.recordId;
    const create = await submit(recordId);
    await f.approveNow(f.p.head, create.id);
    await f.business.decisions.finishActivation(f.worker, create.id);
    const providerId = (await row(recordId)).providerTemplateId!;
    // A Lead may not propose a deletion.
    await expect(f.propose(f.p.lead, f.p.head, { objectKind: TEMPLATE_KIND, objectId: recordId, action: 'DELETE' })).rejects.toMatchObject({ category: 'authorization' });
    const del = await f.propose(f.p.head, f.p.head2, { objectKind: TEMPLATE_KIND, objectId: recordId, action: 'DELETE' });
    await f.approveNow(f.p.head2, del.id);
    expect(f.providerLog.deleted).toEqual([]);
    expect(await f.business.decisions.finishActivation(f.worker, del.id)).toBe('ACTIVATED');
    expect(f.providerLog.deleted).toEqual([providerId]);
    expect((await row(recordId)).deletedAt).not.toBeNull();
  });

  it('deleting a draft the provider never saw applies at approval, without a provider call', async () => {
    const recordId = (await templates.createDraft(act(f.p.lead), f.channelId, draft('never_sent'))).template.submission!.recordId;
    const del = await f.propose(f.p.head, f.p.head2, { objectKind: TEMPLATE_KIND, objectId: recordId, action: 'DELETE' });
    expect(await f.approveNow(f.p.head2, del.id)).toMatchObject({ status: 'APPROVED', activating: false });
    expect((await row(recordId)).deletedAt).not.toBeNull();
    expect(f.providerLog.deleted).toEqual([]);
  });

  it('a template made in the provider’s console is recorded to be deleted, and never counts as OCSO-approved content', async () => {
    f.providerLog.templates.push({ ...templateOf({ ...draft('console_made'), allowCategoryChange: true, header: null, footer: null, buttons: [], authentication: null }, 'HX_CONSOLE'), status: 'APPROVED' });
    const recordId = await templates.deletionTarget(act(f.p.head), f.channelId, 'HX_CONSOLE');
    expect(await templates.deletionTarget(act(f.p.head), f.channelId, 'HX_CONSOLE')).toBe(recordId);
    expect(await row(recordId)).toMatchObject({ origin: 'PROVIDER', providerTemplateId: 'HX_CONSOLE' });
    const d = f.business.registry.get(TEMPLATE_KIND);
    expect(await d.liveObjects(f.t.db)).not.toContain(recordId);
  });

  it('live objects: templates OCSO put at the provider, each approved', async () => {
    const d = f.business.registry.get(TEMPLATE_KIND);
    const live = await d.liveObjects(f.t.db);
    expect(live.length).toBeGreaterThan(0);
    for (const id of live) {
      const [approved] = await f.t.db.select().from(approvalProposals).where(eq(approvalProposals.objectId, id));
      expect(approved?.status, id).toBe('APPROVED');
    }
  });
});
