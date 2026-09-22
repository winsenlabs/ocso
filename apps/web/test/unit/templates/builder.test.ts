import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/actions/templates', () => ({ createTemplateAction: vi.fn(), deleteTemplateAction: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const { EMPTY_FORM, builderState, formToDraft, nextVariable } = await import('../../../components/templates/lib/builder');
const { templateNotice } = await import('../../../components/templates/lib/notices');
const { TemplateBuilder } = await import('../../../components/templates/template-builder');

const form = { ...EMPTY_FORM, name: 'payment_reminder', body: 'Hi {{1}}, your payment of {{2}} is due on the 5th of this month.', examples: { '1': 'Priya', '2': '₹4,200' } };

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
    const state = builderState({ ...form, footer: 'Meridian Bank' }, 'TWILIO_WHATSAPP');
    expect(state.check).toEqual({ problems: [], warnings: [] });
    expect(state.preview.text).toBe('Hi Priya, your payment of ₹4,200 is due on the 5th of this month.\n\nMeridian Bank');
  });

  it('blocks what WhatsApp would reject and warns about marketing wording in a utility template', () => {
    const bad = builderState({ ...form, name: 'Payment Reminder', examples: { '1': 'Priya' } }, 'TWILIO_WHATSAPP');
    expect(bad.check.problems.map((p) => p.field)).toEqual(['name', 'examples.2']);
    const promo = builderState({ ...form, body: 'Hi {{1}}, enjoy an exclusive discount on your next bill of {{2}} this week.' }, 'TWILIO_WHATSAPP');
    expect(promo.check.problems).toEqual([]);
    expect(promo.check.warnings[0]?.message).toMatch(/reads as promotional/);
  });

  it('Meta channels cannot take media headers from the builder (upload handle), Twilio can', () => {
    const media = { ...form, headerKind: 'IMAGE' as const, headerUrl: 'https://cdn.example.com/card.png' };
    expect(builderState(media, 'TWILIO_WHATSAPP').check.problems).toEqual([]);
    expect(builderState(media, 'WHATSAPP').check.problems[0]?.message).toMatch(/WhatsApp Manager/);
  });

  it('authentication uses the fixed code text; Add variable picks the next number', () => {
    const auth = builderState({ ...EMPTY_FORM, name: 'login_code', category: 'AUTHENTICATION', codeExpirationMinutes: '10' }, 'WHATSAPP');
    expect(auth.check.problems).toEqual([]);
    expect(auth.preview.text).toBe('123456 is your verification code. For your security, do not share this code.\n\nThis code expires in 10 minutes.\n\n[Copy code]');
    expect(nextVariable('Hi {{1}} and {{2}}')).toBe('{{3}}');
    expect(nextVariable('')).toBe('{{1}}');
  });
});

describe('builder markup', () => {
  it('renders category guidance, the preview and the submit action', () => {
    const html = renderToStaticMarkup(createElement(TemplateBuilder, { channel: { id: 'c1', kind: 'TWILIO_WHATSAPP', name: 'WhatsApp (Twilio)' }, listHref: '/whatsapp-templates?channel=c1' }));
    expect(html).toContain('aria-label="New WhatsApp template"');
    expect(html).toContain('Updates about something the customer already asked for or bought');
    expect(html).toContain('Preview with your example values');
    expect(html).toContain('Submit for WhatsApp approval');
    expect(html).toContain('href="/whatsapp-templates?channel=c1"');
  });
});

describe('review-result notices', () => {
  const event = { templateId: 'HX1', channelId: 'c1', name: 'payment_reminder', language: 'en', status: 'APPROVED', previousStatus: 'PENDING', submittedBy: 'u1' };
  it('tells the submitter (only) what WhatsApp decided', () => {
    expect(templateNotice('e1', event, 'u1')).toEqual({ id: 'e1', tone: 'good', text: 'Template payment_reminder (en) was approved by WhatsApp — execs can now send it.', href: '/whatsapp-templates?channel=c1' });
    expect(templateNotice('e2', { ...event, status: 'REJECTED' }, 'u1')?.tone).toBe('error');
    expect(templateNotice('e3', event, 'someone-else')).toBeNull();
  });
});
