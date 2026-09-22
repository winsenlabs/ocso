import { describe, expect, it } from 'vitest';
import {
  TemplateDraftSchema,
  checkTemplateDraft,
  draftAsTemplate,
  isTemplateSendable,
  placeholdersIn,
  renderTemplate,
  sessionWindowState,
  templateValueKey,
  templateValueProblems,
  type MessageTemplate,
  type TemplateDraftInput,
} from '../src/index.js';

const twilioTemplate: MessageTemplate = {
  id: 'HX0f0e72ce92eef937d6f481b338ecbd19',
  name: 'order_ready_pickup',
  language: 'en',
  category: 'UTILITY',
  status: 'APPROVED',
  rejectionReason: null,
  header: null,
  body: 'Hi {{1}}, your order {{2}} is ready for pickup at the front desk.',
  footer: 'Meridian Bank',
  buttons: [{ type: 'QUICK_REPLY', text: 'On my way' }],
  variables: [
    { key: '1', placeholder: '1', part: 'body', example: 'Priya' },
    { key: '2', placeholder: '2', part: 'body', example: 'A-10423' },
  ],
  placeholderScope: 'template',
  headerMediaRequired: false,
  contentType: 'twilio/quick-reply',
  unsupportedReason: null,
};

const metaTemplate: MessageTemplate = {
  ...twilioTemplate,
  id: '1387372356726668',
  header: { format: 'TEXT', text: 'Order {{1}}' },
  buttons: [{ type: 'URL', text: 'Track', url: 'https://meridian.example/track/{{1}}' }],
  variables: [
    { key: 'header.1', placeholder: '1', part: 'header' },
    { key: 'body.1', placeholder: '1', part: 'body' },
    { key: 'body.2', placeholder: '2', part: 'body' },
    { key: 'button.0.1', placeholder: '1', part: 'button' },
  ],
  placeholderScope: 'component',
};

describe('template placeholders and rendering', () => {
  it('finds placeholders in order of appearance (numbered and named)', () => {
    expect(placeholdersIn('Hi {{2}} and {{ 1 }} and {{first_name}} and {{2}}')).toEqual(['2', '1', 'first_name']);
    expect(templateValueKey('template', 'button', '1', 2)).toBe('1');
    expect(templateValueKey('component', 'button', '1', 2)).toBe('button.2.1');
  });

  it('renders exactly what the customer receives (Twilio: one namespace for the whole content)', () => {
    const rendered = renderTemplate(twilioTemplate, { '1': 'Priya', '2': 'A-10423' });
    expect(rendered.body).toBe('Hi Priya, your order A-10423 is ready for pickup at the front desk.');
    expect(rendered.text).toBe('Hi Priya, your order A-10423 is ready for pickup at the front desk.\n\nMeridian Bank\n\n[On my way]');
    // Missing values stay visible in the preview.
    expect(renderTemplate(twilioTemplate, { '1': 'Priya' }).body).toContain('{{2}}');
  });

  it('renders Meta templates per component (header {{1}} and body {{1}} are different values)', () => {
    const rendered = renderTemplate(metaTemplate, { 'header.1': 'A-7', 'body.1': 'Priya', 'body.2': 'A-7', 'button.0.1': 'A-7' });
    expect(rendered.header).toBe('Order A-7');
    expect(rendered.body).toBe('Hi Priya, your order A-7 is ready for pickup at the front desk.');
    expect(rendered.buttons).toEqual([{ type: 'URL', text: 'Track', url: 'https://meridian.example/track/A-7' }]);
  });

  it('requires every variable, single-line values, no unknown keys, and a header link when the media is chosen at send time', () => {
    expect(templateValueProblems(twilioTemplate, { '1': 'Priya', '2': 'A-10423' })).toEqual([]);
    expect(templateValueProblems(twilioTemplate, { '1': ' ', '3': 'x' })).toEqual([
      { key: '1', message: '{{1}} (body) required' },
      { key: '2', message: '{{2}} (body) required' },
      { key: '3', message: '3 is not a variable of order_ready_pickup' },
    ]);
    expect(templateValueProblems(twilioTemplate, { '1': 'two\nlines', '2': 'a     b' }).map((p) => p.message)).toEqual([
      '{{1}} (body) must be a single line (no line breaks or tabs)',
      '{{2}} (body) must not contain more than four spaces in a row',
    ]);
    const media = { ...metaTemplate, header: { format: 'IMAGE' as const }, headerMediaRequired: true, variables: [] };
    expect(templateValueProblems(media, {})).toEqual([{ key: 'headerMediaUrl', message: 'this template needs a header media link (https)' }]);
    expect(templateValueProblems(media, {}, 'http://x.example/a.jpg')).toEqual([{ key: 'headerMediaUrl', message: 'header media must be an https link' }]);
    expect(templateValueProblems(media, {}, 'https://cdn.example.com/a.jpg')).toEqual([]);
  });

  it('only approved, supported templates are sendable', () => {
    expect(isTemplateSendable(twilioTemplate)).toBe(true);
    expect(isTemplateSendable({ ...twilioTemplate, status: 'PENDING' })).toBe(false);
    expect(isTemplateSendable({ ...twilioTemplate, unsupportedReason: 'location headers' })).toBe(false);
  });
});

describe('template drafts (builder + API rules)', () => {
  const base: TemplateDraftInput = { name: 'payment_reminder', language: 'en', category: 'UTILITY', body: 'Hi {{1}}, your payment of {{2}} is due on the 5th of this month.', examples: { '1': 'Priya', '2': '₹4,200' } };
  const check = (over: Partial<TemplateDraftInput>) => checkTemplateDraft(TemplateDraftSchema.parse({ ...base, ...over }));
  const messages = (over: Partial<TemplateDraftInput>) => check(over).problems.map((p) => p.message);

  it('accepts a well-formed utility template', () => {
    expect(check({})).toEqual({ problems: [], warnings: [] });
  });

  it('enforces name, language, numbering, examples, and variable placement', () => {
    expect(messages({ name: 'Payment Reminder' })).toEqual(['Use lower-case letters, digits and underscores, e.g. payment_reminder']);
    expect(messages({ language: 'english' })).toEqual(['Use a language code such as en, en_US or hi']);
    expect(messages({ body: 'Hi {{1}}, your payment of {{3}} is due on the 5th of this month.' })).toContain('Number variables in order from {{1}} without gaps');
    expect(messages({ body: '{{1}}, your payment is due on the 5th of this month, thanks.' })).toContain('The text cannot start or end with a variable');
    expect(messages({ body: 'Your payment is due on the 5th of this month, {{1}}.' })).toContain('The text cannot start or end with a variable');
    expect(messages({ body: 'Hi there {{1}} {{2}} is due on the 5th of this month.' })).toContain('Put words between variables ({{1}}{{2}} is rejected)');
    expect(messages({ body: 'Hi {{name}}, your payment is due on the 5th of this month.', examples: {} })).toContain('Use numbered variables such as {{1}}, not {{name}}');
    expect(messages({ examples: { '1': 'Priya' } })).toEqual(['Give an example value for {{2}}']);
    expect(messages({ body: 'Hi {{1}}, due {{2}}.' })).toContain('Too many variables for the text: 2 variable(s) need at least 5 words around them');
  });

  it('checks header, footer and buttons against the stricter provider limits', () => {
    expect(messages({ header: { format: 'TEXT', text: 'Order {{1}}' } })).toEqual(['Variables are supported in the message text only']);
    expect(messages({ header: { format: 'IMAGE', mediaUrl: 'http://cdn.example.com/a.jpg' } })).toEqual(['The header media must be a public https link']);
    expect(messages({ footer: 'x'.repeat(61) })).toEqual(['Footer: at most 60 characters']);
    expect(messages({ buttons: [{ type: 'QUICK_REPLY', text: 'Pay now' }, { type: 'URL', text: 'Pay', url: 'https://pay.example' }] })).toEqual(['Use either quick replies or call-to-action buttons, not both']);
    expect(messages({ buttons: [{ type: 'QUICK_REPLY', text: 'A button text that is far too long' }] })).toEqual(['Button text: at most 20 characters']);
    expect(messages({ buttons: [{ type: 'PHONE_NUMBER', text: 'Call us', phone: '98123' }] })).toEqual(['Call buttons need a phone number like +919812341208']);
  });

  it('warns (without blocking) when a utility template reads as marketing', () => {
    const result = check({ body: 'Hi {{1}}, get 20% cashback on your next bill of {{2}} this week only.' });
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual([{ field: 'category', message: expect.stringMatching(/^"cashback" reads as promotional/) }]);
    expect(check({ category: 'MARKETING', body: 'Hi {{1}}, get 20% cashback on your next bill of {{2}} this week only.' }).warnings).toEqual([]);
  });

  it('authentication templates use the fixed code text and reject extra parts', () => {
    expect(check({ category: 'AUTHENTICATION', body: '', examples: {} }).problems).toEqual([]);
    expect(messages({ category: 'AUTHENTICATION', footer: 'hi' })).toEqual(['Authentication templates use WhatsApp’s fixed code text: remove the header, footer and buttons']);
    const preview = draftAsTemplate(TemplateDraftSchema.parse({ ...base, category: 'AUTHENTICATION', authentication: { codeExpirationMinutes: 10 } }), { id: 'draft', status: 'DRAFT', scope: 'component' });
    expect(renderTemplate(preview, { 'body.1': '482913' }).text).toBe('482913 is your verification code. For your security, do not share this code.\n\nThis code expires in 10 minutes.\n\n[Copy code]');
  });

  it('a draft previews with its examples, keyed for the provider', () => {
    const draft = TemplateDraftSchema.parse({ ...base, header: { format: 'TEXT', text: 'Payment due' }, footer: 'Meridian Bank' });
    const template = draftAsTemplate(draft, { id: 'HXdraft', status: 'PENDING', scope: 'template' });
    expect(template.variables).toEqual([
      { key: '1', placeholder: '1', part: 'body', example: 'Priya' },
      { key: '2', placeholder: '2', part: 'body', example: '₹4,200' },
    ]);
    expect(renderTemplate(template, draft.examples).text).toBe('Payment due\n\nHi Priya, your payment of ₹4,200 is due on the 5th of this month.\n\nMeridian Bank');
  });
});

describe('WhatsApp customer-service window', () => {
  const now = new Date('2026-09-22T10:00:00Z');
  it('is open for 24 hours after the last customer message', () => {
    expect(sessionWindowState(24, new Date('2026-09-21T13:12:00Z'), now)).toEqual({ open: true, closesAt: '2026-09-22T13:12:00.000Z' });
    expect(sessionWindowState(24, new Date('2026-09-21T09:59:59Z'), now)).toEqual({ open: false, closesAt: '2026-09-22T09:59:59.000Z' });
  });

  it('is closed before the customer ever wrote, and absent for channels without a window', () => {
    expect(sessionWindowState(24, null, now)).toEqual({ open: false, closesAt: null });
    expect(sessionWindowState(null, new Date(), now)).toBeNull();
  });
});
