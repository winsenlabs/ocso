import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MessageTemplate } from '@ocso/domain';

// 'use server' module bound to the API client; the components only need references.
vi.mock('../../../lib/actions/conversations', () => ({ sendTemplateAction: vi.fn() }));

const { canReplyFreely, previewOf, searchTemplates, templateHint, valueErrors, windowLine, listProblemText } = await import('../../../components/workspace/lib/template');
const { TemplateForm, TemplatePicker } = await import('../../../components/workspace/template-composer');

const approved: MessageTemplate = {
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
const pending: MessageTemplate = { ...approved, id: 'HX4f797bbf4c5ea0aeb6bf52c4572d788f', name: 'appointment_reminder', status: 'PENDING', category: 'MARKETING' };
const rejected: MessageTemplate = { ...approved, id: 'HXd44344fc2fada9cf545f9e4352636ec8', name: 'invoice_ready', status: 'REJECTED', rejectionReason: 'INVALID_FORMAT' };

describe('reply window line', () => {
  const now = Date.parse('2026-09-22T10:00:00Z');
  it('counts down while open and says what to do once closed', () => {
    expect(windowLine({ open: true, closesAt: '2026-09-22T13:12:30Z' }, now)).toEqual({ tone: 'open', text: 'reply window open · closes in 3h 12m' });
    expect(windowLine({ open: true, closesAt: '2026-09-22T10:00:20Z' }, now)?.text).toBe('reply window open · closes in under a minute');
    expect(windowLine({ open: false, closesAt: '2026-09-22T09:00:00Z', hours: 24 }, now)).toEqual({ tone: 'closed', text: '24-hour reply window closed — send an approved template' });
    expect(windowLine({ open: false, closesAt: '2026-09-22T09:00:00Z' }, now)?.text).toBe('reply window closed — send an approved template');
    // The page was rendered while open; the clock has since passed closesAt.
    expect(windowLine({ open: true, closesAt: '2026-09-22T09:59:00Z' }, now)?.tone).toBe('closed');
    expect(windowLine({ open: false, closesAt: null }, now)?.text).toMatch(/No customer message yet/);
    expect(windowLine(null, now)).toBeNull();
    expect(canReplyFreely(null, now)).toBe(true);
    expect(canReplyFreely({ open: false, closesAt: '2026-09-22T09:00:00Z' }, now)).toBe(false);
  });
});

describe('template picker helpers', () => {
  it('lists sendable templates first, searches name/text/category/language, and explains the rest', () => {
    expect(searchTemplates([rejected, pending, approved], '').map((t) => t.name)).toEqual(['order_ready_pickup', 'invoice_ready', 'appointment_reminder']);
    expect(searchTemplates([rejected, pending, approved], 'marketing').map((t) => t.name)).toEqual(['appointment_reminder']);
    expect(templateHint(approved)).toBeNull();
    expect(templateHint(pending)).toBe('in review — only approved templates can be sent');
    expect(templateHint(rejected)).toBe('rejected: INVALID_FORMAT');
    expect(listProblemText({ code: 'templates_not_configured', message: 'Add the WhatsApp Business Account id' })).toMatch(/Tech admin adds it under Connections → Channels/);
  });

  it('validates every variable like the API and previews the exact text', () => {
    expect(valueErrors(approved, { '1': 'Priya', '2': '' }, '')).toEqual({ '2': '{{2}} (body) required' });
    expect(valueErrors(approved, { '1': ' Priya ', '2': 'A-7' }, '')).toEqual({});
    expect(previewOf(approved, { '1': ' Priya ', '2': 'A-7' }, '').text).toBe('Hi Priya, your order A-7 is ready for pickup at the front desk.\n\nMeridian Bank\n\n[On my way]');
  });
});

describe('Template mode markup', () => {
  const list = (templates: MessageTemplate[], problem: { code: string; message: string } | null = null) => ({ channel: { id: 'c1', kind: 'TWILIO_WHATSAPP', name: 'WhatsApp (Twilio)' }, templates, fetchedAt: null, problem });
  const picker = (l: ReturnType<typeof list>, query = '') => renderToStaticMarkup(createElement(TemplatePicker, { list: l, query, onQuery: () => {}, refreshing: false, onRefresh: () => {}, onPick: () => {} }));

  it('picker: category badge, language, disabled unapproved templates with the reason', () => {
    const html = picker(list([approved, rejected]));
    expect(html).toContain('order_ready_pickup');
    expect(html).toContain('>utility<');
    expect(html).toContain('rejected: INVALID_FORMAT');
    expect(html).toMatch(/<button type="button" class="tool-opt" disabled="" aria-disabled="true">/);
    expect(html).toContain('placeholder="Search approved templates"');
  });

  it('picker: honest empty states', () => {
    expect(picker(list([]))).toContain('No message templates on WhatsApp (Twilio) yet');
    expect(picker(list([]))).toContain('the provider reviews each one');
    expect(renderToStaticMarkup(createElement(TemplatePicker, { list: list([]), query: '', onQuery: () => {}, refreshing: false, onRefresh: () => {}, onPick: () => {}, reviewer: 'WhatsApp' }))).toContain('WhatsApp reviews each one');
    expect(picker(list([pending]))).toContain('None of the 1 templates on WhatsApp (Twilio) is approved yet');
    expect(picker(list([], { code: 'templates_auth_failed', message: 'Twilio rejected the channel credentials' }))).toContain('check the credentials with Test on the channel');
    expect(picker(list([approved]), 'zzz')).toContain('No template matches “zzz”.');
  });

  it('form: one required input per variable with the example as placeholder, live preview, reopen wording', () => {
    const html = renderToStaticMarkup(createElement(TemplateForm, { template: approved, conversationId: 'c', customerName: 'Priya', reopen: true, onBack: () => {}, onSent: () => {} }));
    expect(html).toContain('>{{1}} · body</label>');
    expect(html).toContain('placeholder="e.g. Priya"');
    expect(html.match(/required=""/g)).toHaveLength(2);
    expect(html).toContain('Preview · what the customer receives');
    expect(html).toContain('Hi {{1}}, your order {{2}} is ready for pickup at the front desk.');
    expect(html).toContain('Reopen and send template');
  });

  it('form: templates whose header media is chosen at send time ask for the link', () => {
    const media: MessageTemplate = { ...approved, header: { format: 'IMAGE' }, headerMediaRequired: true, variables: [] };
    const html = renderToStaticMarkup(createElement(TemplateForm, { template: media, conversationId: 'c', customerName: 'Priya', reopen: false, onBack: () => {}, onSent: () => {} }));
    expect(html).toContain('Header image · public https link');
    expect(html).toContain('Send template');
  });
});
