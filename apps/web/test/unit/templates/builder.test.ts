import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/actions/templates', () => ({ createTemplateAction: vi.fn(), deleteTemplateAction: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const { EMPTY_FORM, builderState, formToDraft, nextVariable } = await import('../../../components/templates/lib/builder');
const { templateNotice } = await import('../../../components/templates/lib/notices');
const { TemplateBuilder } = await import('../../../components/templates/template-builder');

const form = { ...EMPTY_FORM, name: 'payment_reminder', body: 'Hi {{1}}, your payment of {{2}} is due on the 5th of this month.', examples: { '1': 'Priya', '2': '₹4,200' } };

/** Template rules as the kinds' descriptors declare them (GET /v1/message-templates/channels `templates`). */
const TWILIO = { placeholderScope: 'template' as const };
const META = { placeholderScope: 'component' as const, mediaHeaderUnsupported: 'Meta needs an uploaded sample for media headers: create this one in WhatsApp Manager (it will show up here), or use a text header' };

describe('template builder state', () => {
  it('turns the form into the API draft and previews it with the examples', () => {
    expect(formToDraft({ ...form, headerKind: 'TEXT', headerText: 'Payment due', footer: 'Meridian Bank', buttonKind: 'QUICK_REPLY', quickReplies: ['Paid already'] })).toMatchObject({
      name: 'payment_reminder',
      header: { format: 'TEXT', text: 'Payment due' },
      footer: 'Meridian Bank',
      buttons: [{ type: 'QUICK_REPLY', text: 'Paid already' }],
      examples: { '1': 'Priya', '2': '₹4,200' },
      authentication: null,
    });
    const state = builderState({ ...form, footer: 'Meridian Bank' }, TWILIO);
    expect(state.check).toEqual({ problems: [], warnings: [] });
    expect(state.preview.text).toBe('Hi Priya, your payment of ₹4,200 is due on the 5th of this month.\n\nMeridian Bank');
  });

  it('blocks what WhatsApp would reject and warns about marketing wording in a utility template', () => {
    const bad = builderState({ ...form, name: 'Payment Reminder', examples: { '1': 'Priya' } }, TWILIO);
    expect(bad.check.problems.map((p) => p.field)).toEqual(['name', 'examples.2']);
    const promo = builderState({ ...form, body: 'Hi {{1}}, enjoy an exclusive discount on your next bill of {{2}} this week.' }, TWILIO);
    expect(promo.check.problems).toEqual([]);
    expect(promo.check.warnings[0]?.message).toMatch(/reads as promotional/);
  });

  it('applies the kind’s own template rules from its descriptor (Meta cannot take media headers from the builder, Twilio can)', () => {
    const media = { ...form, headerKind: 'IMAGE' as const, headerUrl: 'https://cdn.example.com/card.png' };
    expect(builderState(media, TWILIO).check.problems).toEqual([]);
    expect(builderState(media, META).check.problems[0]?.message).toMatch(/WhatsApp Manager/);
    // Meta numbers variables per component; the preview uses the same keys the API will.
    expect(builderState(form, META).preview.text).toBe(builderState(form, TWILIO).preview.text);
  });

  it('authentication uses the fixed code text; Add variable picks the next number', () => {
    const auth = builderState({ ...EMPTY_FORM, name: 'login_code', category: 'AUTHENTICATION', codeExpirationMinutes: '10' }, META);
    expect(auth.check.problems).toEqual([]);
    expect(auth.preview.text).toBe('123456 is your verification code. For your security, do not share this code.\n\nThis code expires in 10 minutes.\n\n[Copy code]');
    expect(nextVariable('Hi {{1}} and {{2}}')).toBe('{{3}}');
    expect(nextVariable('')).toBe('{{1}}');
  });
});

describe('builder markup', () => {
  it('renders category guidance, the preview and the submit action', () => {
    const html = renderToStaticMarkup(createElement(TemplateBuilder, { channel: { id: 'c1', kind: 'TWILIO_WHATSAPP', name: 'WhatsApp (Twilio)' }, terms: { reviewer: 'WhatsApp', ...TWILIO }, listHref: '/templates?channel=c1' }));
    expect(html).toContain('aria-label="New message template"');
    expect(html).toContain('Updates about something the customer already asked for or bought');
    expect(html).toContain('Preview with your example values');
    expect(html).toContain('Submit for WhatsApp approval');
    expect(html).toContain('href="/templates?channel=c1"');
  });
});

describe('review-result notices', () => {
  const event = { templateId: 'HX1', channelId: 'c1', name: 'payment_reminder', language: 'en', status: 'APPROVED', previousStatus: 'PENDING', submittedBy: 'u1' };
  it('tells the submitter (only) what the provider decided', () => {
    expect(templateNotice('e1', event, 'u1')).toEqual({ id: 'e1', tone: 'good', text: 'Template payment_reminder (en) was approved — execs can now send it.', href: '/templates?channel=c1' });
    expect(templateNotice('e2', { ...event, status: 'REJECTED' }, 'u1')?.tone).toBe('error');
    expect(templateNotice('e3', event, 'someone-else')).toBeNull();
  });
});
