import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TemplateDraftSchema, type MessageTemplate } from '@ocso/domain';
import { createTwilioWhatsAppAdapter } from '../src/index.js';
import { fakeFetch, target } from './helpers/whatsapp.js';
import { ACCOUNT_SID, AUTH_TOKEN, NOW, SENDER, basic, twConfig, twilioJson } from './helpers/twilio.js';

/** Recorded Content API shapes (PM/research/10 §11). */
const recorded = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`./fixtures/templates/${name}.json`, import.meta.url), 'utf8'));
const CONTENT = 'https://content.twilio.com/v1';
const APPOINTMENT = 'HX4f797bbf4c5ea0aeb6bf52c4572d788f';

function setup(respond: (url: string, method: string) => Response) {
  const { fetch, calls } = fakeFetch((url, call) => respond(url, call.method));
  return { adapter: createTwilioWhatsAppAdapter({ fetch, now: () => NOW }), calls };
}

const byName = (list: MessageTemplate[], name: string) => list.find((t) => t.name === name)!;

describe('Twilio templates — listing (GET /v1/ContentAndApprovals)', () => {
  it('normalizes text, quick-reply and media content with their WhatsApp approval, and follows next_page_url', async () => {
    const first = recorded('twilio-content-and-approvals');
    const second = { contents: [recorded('twilio-content-item-channel-keyed')], meta: { next_page_url: null, key: 'contents' } };
    const { adapter, calls } = setup((url) => twilioJson(url.includes('PageToken') ? second : first));
    const list = await adapter.listTemplates(twConfig());
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', `${CONTENT}/ContentAndApprovals?PageSize=500`],
      ['GET', 'https://content.twilio.com/v1/ContentAndApprovals?PageSize=50&Page=1&PageToken=PAHX57def8125582d179373231006d5b2418'],
    ]);
    expect(calls[0]?.headers.get('authorization')).toBe(basic(ACCOUNT_SID, AUTH_TOKEN));
    expect(list.map((t) => [t.name, t.status, t.category, t.contentType])).toEqual([
      ['order_ready_pickup', 'APPROVED', 'UTILITY', 'twilio/text'],
      ['appointment_reminder', 'PENDING', 'UTILITY', 'twilio/quick-reply'],
      ['invoice_ready', 'REJECTED', 'UTILITY', 'twilio/media'],
      ['welcome_back_draft', 'DRAFT', null, 'twilio/text'],
      // Channel-keyed `approval_requests: { whatsapp: {…} }` parses the same.
      ['delivery_delayed', 'PAUSED', 'UTILITY', 'twilio/text'],
    ]);
    expect(byName(list, 'order_ready_pickup')).toMatchObject({
      id: 'HX0f0e72ce92eef937d6f481b338ecbd19',
      language: 'en',
      body: 'Hi {{1}}, your order {{2}} is ready for pickup at the front desk. Reply STOP to opt out.',
      placeholderScope: 'template',
      headerMediaRequired: false,
      unsupportedReason: null,
      variables: [
        { key: '1', placeholder: '1', part: 'body', example: 'Priya' },
        { key: '2', placeholder: '2', part: 'body', example: 'A-10423' },
      ],
    });
    expect(byName(list, 'appointment_reminder').buttons).toEqual([
      { type: 'QUICK_REPLY', text: 'Yes, confirm' },
      { type: 'QUICK_REPLY', text: 'Reschedule' },
    ]);
    const invoice = byName(list, 'invoice_ready');
    expect(invoice.header).toEqual({ format: 'DOCUMENT', mediaUrl: 'https://files.example.com/{{1}}' });
    expect(invoice.variables).toEqual([{ key: '1', placeholder: '1', part: 'header', example: 'invoices/INV-2291.pdf' }]);
    expect(invoice.rejectionReason).toMatch(/^INVALID_FORMAT\. Facebook is not able/);
  });

  it('never follows a next_page_url off the Content API origin', async () => {
    const page = { contents: [], meta: { next_page_url: 'https://evil.example/v1/ContentAndApprovals?PageToken=x' } };
    const { adapter, calls } = setup(() => twilioJson(page));
    expect(await adapter.listTemplates(twConfig())).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('maps credential and outage failures to typed template errors', async () => {
    const auth = setup(() => twilioJson({ code: 20003, message: 'Authenticate', status: 401 }, 401));
    await expect(auth.adapter.listTemplates(twConfig())).rejects.toMatchObject({ code: 'templates_auth_failed', message: expect.stringMatching(/Twilio rejected the channel credentials/) });
    const down = setup(() => twilioJson({ message: 'unavailable' }, 503));
    await expect(down.adapter.listTemplates(twConfig())).rejects.toMatchObject({ code: 'templates_unavailable', category: 'provider_unavailable' });
  });

  it('uses the configured Content API base URL (tests, egress proxies)', async () => {
    const { adapter, calls } = setup(() => twilioJson({ contents: [], meta: { next_page_url: null } }));
    await adapter.listTemplates(twConfig({ contentApiBaseUrl: 'http://127.0.0.1:4010/' }));
    expect(calls[0]?.url).toBe('http://127.0.0.1:4010/v1/ContentAndApprovals?PageSize=500');
  });
});

describe('Twilio templates — create + submit, status, delete', () => {
  const draft = TemplateDraftSchema.parse({
    name: 'appointment_reminder',
    language: 'en',
    category: 'UTILITY',
    body: 'Hi {{1}}, this is a reminder of your appointment on {{2}}. Can you make it?',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Yes, confirm' },
      { type: 'QUICK_REPLY', text: 'Reschedule' },
    ],
    examples: { '1': 'Sam', '2': 'Tuesday at 3pm' },
  });

  it('POSTs the content as JSON, then the WhatsApp approval request, and returns it in review', async () => {
    const { adapter, calls } = setup((url) => twilioJson(url.endsWith('/ApprovalRequests/whatsapp') ? recorded('twilio-approval-created') : recorded('twilio-content-created'), 201));
    const created = await adapter.createTemplate(twConfig(), draft);
    expect(calls.map((c) => [c.method, c.url, c.headers.get('content-type')])).toEqual([
      ['POST', `${CONTENT}/Content`, 'application/json'],
      ['POST', `${CONTENT}/Content/${APPOINTMENT}/ApprovalRequests/whatsapp`, 'application/json'],
    ]);
    expect(calls[0]?.body).toEqual({
      friendly_name: 'appointment_reminder',
      language: 'en',
      variables: { '1': 'Sam', '2': 'Tuesday at 3pm' },
      types: {
        'twilio/quick-reply': {
          body: 'Hi {{1}}, this is a reminder of your appointment on {{2}}. Can you make it?',
          actions: [
            { title: 'Yes, confirm', id: 'reply_1' },
            { title: 'Reschedule', id: 'reply_2' },
          ],
        },
      },
    });
    // allow_category_change is response-only on Twilio.
    expect(calls[1]?.body).toEqual({ name: 'appointment_reminder', category: 'UTILITY' });
    expect(created).toMatchObject({ id: APPOINTMENT, status: 'PENDING', category: 'UTILITY', contentType: 'twilio/quick-reply', placeholderScope: 'template' });
  });

  it('chooses whatsapp/card for a text header and footer, and whatsapp/authentication for codes', async () => {
    const { adapter, calls } = setup((url) => twilioJson(url.endsWith('/whatsapp') ? recorded('twilio-approval-created') : recorded('twilio-content-created'), 201));
    const card = TemplateDraftSchema.parse({ ...draft, header: { format: 'TEXT', text: 'Appointment' }, footer: 'Meridian Bank', buttons: [{ type: 'URL', text: 'Manage', url: 'https://meridian.example/appointments' }] });
    await adapter.createTemplate(twConfig(), card);
    expect(calls[0]?.body).toMatchObject({ types: { 'whatsapp/card': { header_text: 'Appointment', footer: 'Meridian Bank', actions: [{ type: 'URL', title: 'Manage', url: 'https://meridian.example/appointments' }] } } });
    const auth = TemplateDraftSchema.parse({ name: 'login_code', language: 'en', category: 'AUTHENTICATION', authentication: { codeExpirationMinutes: 10 } });
    await adapter.createTemplate(twConfig(), auth);
    expect(calls[2]?.body).toEqual({
      friendly_name: 'login_code',
      language: 'en',
      variables: { '1': '123456' },
      types: { 'whatsapp/authentication': { add_security_recommendation: true, code_expiration_minutes: 10, actions: [{ type: 'COPY_CODE', copy_code_text: 'Copy code' }] } },
    });
  });

  it('removes the content again when the approval request is refused', async () => {
    const { adapter, calls } = setup((url, method) => {
      if (method === 'DELETE') return new Response(null, { status: 204 });
      if (url.endsWith('/whatsapp')) return twilioJson({ code: 20001, message: 'Template name already exists', status: 400 }, 400);
      return twilioJson(recorded('twilio-content-created'), 201);
    });
    await expect(adapter.createTemplate(twConfig(), draft)).rejects.toMatchObject({ code: 'template_rejected_by_provider', message: expect.stringMatching(/Template name already exists/) });
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST', 'DELETE']);
    expect(calls[2]?.url).toBe(`${CONTENT}/Content/${APPOINTMENT}`);
  });

  it('reads the review state from /ApprovalRequests; a missing content is null, never submitted is DRAFT', async () => {
    const { adapter } = setup((url) => twilioJson(url.endsWith('/ApprovalRequests') ? recorded('twilio-approval-fetch') : recorded('twilio-content-created')));
    expect(await adapter.templateStatus(twConfig(), APPOINTMENT)).toMatchObject({ id: APPOINTMENT, status: 'APPROVED', category: 'UTILITY' });
    const gone = setup(() => twilioJson({ code: 20404, message: 'not found', status: 404 }, 404));
    expect(await gone.adapter.templateStatus(twConfig(), APPOINTMENT)).toBeNull();
    const unsubmitted = setup((url) => (url.endsWith('/ApprovalRequests') ? twilioJson({ code: 20404, status: 404 }, 404) : twilioJson(recorded('twilio-content-created'))));
    expect(await unsubmitted.adapter.templateStatus(twConfig(), APPOINTMENT)).toMatchObject({ status: 'DRAFT' });
  });

  it('DELETEs the content (a 404 counts as already deleted)', async () => {
    const { adapter, calls } = setup(() => new Response(null, { status: 204 }));
    await adapter.deleteTemplate(twConfig(), { id: APPOINTMENT, name: 'appointment_reminder' });
    expect(calls.map((c) => [c.method, c.url])).toEqual([['DELETE', `${CONTENT}/Content/${APPOINTMENT}`]]);
  });
});

describe('Twilio templates — sending a listed template', () => {
  it('sends ContentSid + ContentVariables outside the 24-hour window', async () => {
    const calls: Array<{ url: string; form: URLSearchParams }> = [];
    const adapter = createTwilioWhatsAppAdapter({
      now: () => NOW,
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ url, form: new URLSearchParams(String(init?.body)) });
        return twilioJson({ sid: 'SMf0e1d2c3b4a5968778695a4b3c2d1e0f', status: 'queued' }, 201);
      }) as typeof fetch,
    });
    const template = { id: 'HX0f0e72ce92eef937d6f481b338ecbd19', name: 'order_ready_pickup', language: 'en' } as unknown as MessageTemplate;
    const stale = target({ identityValue: '+919812341208', lastInboundAt: new Date(NOW.getTime() - 30 * 3_600_000) });
    const result = await adapter.sendTemplate(stale, { templateId: template.id, language: 'en', variables: { '1': 'Priya', '2': 'A-10423' }, template }, twConfig());
    expect(result).toEqual({ ok: true, externalMessageId: 'SMf0e1d2c3b4a5968778695a4b3c2d1e0f' });
    expect(Object.fromEntries(calls[0]!.form)).toMatchObject({ To: 'whatsapp:+919812341208', From: SENDER, ContentSid: template.id, ContentVariables: '{"1":"Priya","2":"A-10423"}' });
  });
});
