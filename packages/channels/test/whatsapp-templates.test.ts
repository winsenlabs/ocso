import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TemplateDraftSchema, type MessageTemplate } from '@ocso/domain';
import { createWhatsAppAdapter } from '../src/index.js';
import { ACCESS_TOKEN, GRAPH, NOW, PHONE_NUMBER_ID, WABA_ID, fakeFetch, graphError, json, postRequest, target, waConfig } from './helpers/whatsapp.js';

/** Recorded Cloud API shapes (PM/research/10 §11). */
const recorded = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`./fixtures/templates/${name}.json`, import.meta.url), 'utf8'));
const withWaba = () => waConfig({ businessAccountId: WABA_ID });
const FIELDS = 'fields=id%2Cname%2Clanguage%2Cstatus%2Ccategory%2Ccomponents%2Cparameter_format%2Crejected_reason';

function setup(respond: (url: string, method: string) => Response) {
  const { fetch, calls } = fakeFetch((url, call) => respond(url, call.method));
  return { adapter: createWhatsAppAdapter({ fetch, now: () => NOW }), calls };
}

const byName = (list: MessageTemplate[], name: string) => list.find((t) => t.name === name)!;

describe('Meta templates — listing (GET /{WABA}/message_templates)', () => {
  it('normalizes positional and named templates, per-component variable keys, and follows paging.next on the Graph origin', async () => {
    const { adapter, calls } = setup((url) => json(url.includes('after=') ? { data: [], paging: {} } : recorded('meta-templates-page')));
    const list = await adapter.listTemplates(withWaba());
    expect(calls.map((c) => c.url)).toEqual([
      `${GRAPH}/${WABA_ID}/message_templates?${FIELDS}&limit=100`,
      `${GRAPH}/${WABA_ID}/message_templates?fields=id%2Cname%2Clanguage%2Cstatus%2Ccategory%2Ccomponents%2Cparameter_format%2Crejected_reason%2Cquality_score&limit=4&after=QVFIUkZAhNEtwUXRJ`,
    ]);
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(list.map((t) => [t.name, t.language, t.status, t.category])).toEqual([
      ['order_ready_pickup', 'en_US', 'APPROVED', 'UTILITY'],
      ['booking_confirmation', 'en_US', 'APPROVED', 'UTILITY'],
      ['weekend_sale', 'en', 'REJECTED', 'MARKETING'],
      ['cart_reminder', 'en', 'PAUSED', 'MARKETING'],
    ]);
    const order = byName(list, 'order_ready_pickup');
    expect(order).toMatchObject({ header: { format: 'TEXT', text: 'Order {{1}} is ready' }, footer: 'Reply STOP to opt out', placeholderScope: 'component', headerMediaRequired: false, unsupportedReason: null });
    expect(order.variables).toEqual([
      { key: 'header.1', placeholder: '1', part: 'header', example: 'A-10423' },
      { key: 'body.1', placeholder: '1', part: 'body', example: 'Priya' },
      { key: 'body.2', placeholder: '2', part: 'body', example: 'the front desk' },
    ]);
    const booking = byName(list, 'booking_confirmation');
    expect(booking).toMatchObject({ header: { format: 'IMAGE' }, headerMediaRequired: true });
    expect(booking.variables).toEqual([
      { key: 'body.first_name', placeholder: 'first_name', part: 'body', example: 'Pablo' },
      { key: 'body.booking_ref', placeholder: 'booking_ref', part: 'body', example: 'BK-7781' },
      { key: 'button.0.1', placeholder: '1', part: 'button', example: 'https://example.com/bookings/BK-7781' },
    ]);
    expect(booking.buttons).toEqual([
      { type: 'URL', text: 'View booking', url: 'https://example.com/bookings/{{1}}' },
      { type: 'PHONE_NUMBER', text: 'Call us', phone: '+15550051310' },
    ]);
    expect(byName(list, 'weekend_sale').rejectionReason).toBe('INVALID_FORMAT');
    expect(byName(list, 'order_ready_pickup').rejectionReason).toBeNull();
  });

  it('needs the WhatsApp Business Account id and says so', async () => {
    const { adapter, calls } = setup(() => json({}));
    await expect(adapter.listTemplates(waConfig())).rejects.toMatchObject({ code: 'templates_not_configured', message: expect.stringMatching(/WhatsApp Business Account id/) });
    expect(calls).toHaveLength(0);
  });

  it('hides deleted templates and marks unsendable components', async () => {
    const page = {
      data: [
        { id: '1', name: 'gone', language: 'en', status: 'PENDING_DELETION', category: 'UTILITY', components: [{ type: 'BODY', text: 'x' }] },
        { id: '2', name: 'catalog_offer', language: 'en', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'See our catalog' }, { type: 'BUTTONS', buttons: [{ type: 'CATALOG', text: 'View catalog' }] }] },
        { id: '3', name: 'store_location', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'HEADER', format: 'LOCATION' }, { type: 'BODY', text: 'Visit us' }] },
      ],
    };
    const { adapter } = setup(() => json(page));
    const list = await adapter.listTemplates(withWaba());
    expect(list.map((t) => [t.name, t.unsupportedReason])).toEqual([
      ['catalog_offer', expect.stringMatching(/cannot be sent from OCSO yet/)],
      ['store_location', 'location headers cannot be sent from OCSO yet'],
    ]);
  });

  it('a token without whatsapp_business_management is a credentials problem', async () => {
    const { adapter } = setup(() => graphError(403, 200, 'Requires whatsapp_business_management permission'));
    await expect(adapter.listTemplates(withWaba())).rejects.toMatchObject({ code: 'templates_auth_failed', message: expect.stringMatching(/whatsapp_business_management/) });
  });
});

describe('Meta templates — create, status, delete', () => {
  const draft = TemplateDraftSchema.parse({
    name: 'order_ready_pickup',
    language: 'en_US',
    category: 'UTILITY',
    header: { format: 'TEXT', text: 'Your order is ready' },
    body: 'Hi {{1}}, your order is ready for pickup at {{2}}. See you soon!',
    footer: 'Reply STOP to opt out',
    buttons: [{ type: 'QUICK_REPLY', text: 'On my way' }],
    examples: { '1': 'Priya', '2': 'the front desk' },
  });

  it('POSTs components with examples to the WABA and returns the template in review', async () => {
    const { adapter, calls } = setup(() => json(recorded('meta-template-created')));
    const created = await adapter.createTemplate(withWaba(), draft);
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${GRAPH}/${WABA_ID}/message_templates` });
    expect(calls[0]?.body).toEqual({
      name: 'order_ready_pickup',
      language: 'en_US',
      category: 'UTILITY',
      allow_category_change: true,
      parameter_format: 'POSITIONAL',
      components: [
        { type: 'HEADER', format: 'TEXT', text: 'Your order is ready' },
        { type: 'BODY', text: 'Hi {{1}}, your order is ready for pickup at {{2}}. See you soon!', example: { body_text: [['Priya', 'the front desk']] } },
        { type: 'FOOTER', text: 'Reply STOP to opt out' },
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'On my way' }] },
      ],
    });
    expect(created).toMatchObject({ id: '1689556908129832', status: 'PENDING', category: 'UTILITY', placeholderScope: 'component' });
    expect(created.variables.map((v) => v.key)).toEqual(['body.1', 'body.2']);
  });

  it('refuses media headers (Meta needs an upload handle) and builds authentication templates', async () => {
    const { adapter, calls } = setup(() => json(recorded('meta-template-created')));
    const media = TemplateDraftSchema.parse({ ...draft, header: { format: 'IMAGE', mediaUrl: 'https://cdn.example.com/a.jpg' } });
    await expect(adapter.createTemplate(withWaba(), media)).rejects.toMatchObject({ code: 'template_unsupported', message: expect.stringMatching(/WhatsApp Manager/) });
    await adapter.createTemplate(withWaba(), TemplateDraftSchema.parse({ name: 'login_code', language: 'en', category: 'AUTHENTICATION', authentication: { codeExpirationMinutes: 5 } }));
    expect(calls[0]?.body).toMatchObject({
      category: 'AUTHENTICATION',
      components: [
        { type: 'BODY', add_security_recommendation: true },
        { type: 'FOOTER', code_expiration_minutes: 5 },
        { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }] },
      ],
    });
  });

  it('reads one template by id; unknown ids are null', async () => {
    const item = (recorded('meta-templates-page')['data'] as unknown[])[2];
    const { adapter, calls } = setup(() => json(item));
    expect(await adapter.templateStatus(withWaba(), '1166414785519855')).toMatchObject({ status: 'REJECTED', rejectionReason: 'INVALID_FORMAT' });
    expect(calls[0]?.url).toBe(`${GRAPH}/1166414785519855?${FIELDS}`);
    const gone = setup(() => graphError(400, 100, 'Unsupported get request. Object with ID does not exist'));
    expect(await gone.adapter.templateStatus(withWaba(), '1166414785519855')).toBeNull();
  });

  it('deletes by hsm_id and name (name alone would delete every language)', async () => {
    const { adapter, calls } = setup(() => json({ success: true }));
    await adapter.deleteTemplate(withWaba(), { id: '1689556908129832', name: 'order_ready_pickup' });
    expect(calls.map((c) => [c.method, c.url])).toEqual([['DELETE', `${GRAPH}/${WABA_ID}/message_templates?hsm_id=1689556908129832&name=order_ready_pickup`]]);
  });
});

describe('Meta templates — sending a listed template', () => {
  const sent = () => json({ messaging_product: 'whatsapp', contacts: [{ input: '+919812341208', wa_id: '919812341208' }], messages: [{ id: 'wamid.TPL.1' }] });
  const stale = target({ identityValue: '+919812341208', lastInboundAt: new Date(NOW.getTime() - 48 * 3_600_000) });

  it('fills header, body and URL-button parameters in placeholder order (positional and named)', async () => {
    const [order, booking] = (recorded('meta-templates-page')['data'] as unknown[]).slice(0, 2);
    const listing = setup(() => json({ data: [order, booking] }));
    const [positional, named] = await listing.adapter.listTemplates(withWaba());
    const { adapter, calls } = setup(() => sent());
    const values = { 'header.1': 'A-10423', 'body.1': 'Priya', 'body.2': 'Counter 3' };
    expect(await adapter.sendTemplate(stale, { templateId: positional!.id, language: 'en_US', variables: values, template: positional! }, withWaba())).toEqual({ ok: true, externalMessageId: 'wamid.TPL.1' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${GRAPH}/${PHONE_NUMBER_ID}/messages` });
    expect(calls[0]?.body).toMatchObject({
      type: 'template',
      template: {
        name: 'order_ready_pickup',
        language: { code: 'en_US' },
        components: [
          { type: 'header', parameters: [{ type: 'text', text: 'A-10423' }] },
          { type: 'body', parameters: [{ type: 'text', text: 'Priya' }, { type: 'text', text: 'Counter 3' }] },
        ],
      },
    });
    const namedValues = { 'body.first_name': 'Pablo', 'body.booking_ref': 'BK-7781', 'button.0.1': 'BK-7781' };
    await adapter.sendTemplate(stale, { templateId: named!.id, language: 'en_US', variables: namedValues, headerMediaUrl: 'https://cdn.example.com/booking.jpg', template: named! }, withWaba());
    expect((calls[1]?.body as { template: { components: unknown[] } }).template.components).toEqual([
      { type: 'header', parameters: [{ type: 'image', image: { link: 'https://cdn.example.com/booking.jpg' } }] },
      { type: 'body', parameters: [{ type: 'text', parameter_name: 'first_name', text: 'Pablo' }, { type: 'text', parameter_name: 'booking_ref', text: 'BK-7781' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'BK-7781' }] },
    ]);
  });

  it('a media header without a link is a failure before any call', async () => {
    const booking = (recorded('meta-templates-page')['data'] as unknown[])[1];
    const [template] = await setup(() => json({ data: [booking] })).adapter.listTemplates(withWaba());
    const { adapter, calls } = setup(() => sent());
    const result = await adapter.sendTemplate(stale, { templateId: template!.id, language: 'en_US', variables: {}, template: template! }, withWaba());
    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_template' });
    expect(calls).toHaveLength(0);
  });
});

describe('Meta template status webhooks (message_template_status_update)', () => {
  const adapter = createWhatsAppAdapter({ fetch: () => Promise.reject(new Error('offline')), now: () => NOW });
  const parse = (name: string) => {
    const body = Buffer.from(JSON.stringify(recorded(name)));
    return adapter.parseInbound(postRequest(body), withWaba());
  };

  it('turns review results into template updates (integer ids, hyphenated languages, reasons)', () => {
    expect(parse('meta-webhook-approved').templateUpdates).toEqual([{ templateId: '1689556908129832', name: 'order_confirmation', language: 'en_US', status: 'APPROVED', reason: null, occurredAt: NOW }]);
    expect(parse('meta-webhook-rejected').templateUpdates).toEqual([
      expect.objectContaining({ templateId: '1689556908129835', status: 'REJECTED', reason: expect.stringMatching(/^INVALID_FORMAT: Your template has parameters placed next to each other/) }),
    ]);
    expect(parse('meta-webhook-paused').templateUpdates).toEqual([expect.objectContaining({ status: 'PAUSED', reason: 'Your WhatsApp message template has been paused for 3 hours.' })]);
    expect(parse('meta-webhook-disabled').templateUpdates).toEqual([expect.objectContaining({ status: 'DISABLED' })]);
    // Category changes are not review results.
    expect(parse('meta-webhook-category')).toMatchObject({ templateUpdates: [], ignored: 1 });
  });
});
