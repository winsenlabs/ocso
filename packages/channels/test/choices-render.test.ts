import { describe, expect, it } from 'vitest';
import { choicesPart, type ChoicesData, type InteractionPart } from '@ocso/domain';
import {
  WebChatChannelAdapter,
  choicesPresentation,
  createTwilioWhatsAppAdapter,
  createWhatsAppAdapter,
  renderChoicesAsText,
  WHATSAPP_CAPABILITIES,
  TWILIO_WHATSAPP_CAPABILITIES,
  WEBCHAT_CAPABILITIES,
} from '../src/index.js';
import { twConfig } from './helpers/twilio.js';
import { waConfig } from './helpers/whatsapp.js';

/** The CHOICES part (PM/research/11 §5.4): native where the channel declares `choices`, numbered text otherwise. */
const offline = { fetch: () => Promise.reject(new Error('offline')) };
const options = (n: number, label = (i: number) => `Option ${i + 1}`) => Array.from({ length: n }, (_, i) => ({ id: `ocso:step:v${i + 1}`, label: label(i) }));
const question = (n: number, label?: (i: number) => string): ChoicesData => ({ text: 'What can we help with?', options: options(n, label) });
const wa = (data: ChoicesData) => createWhatsAppAdapter(offline).render([choicesPart(data)], waConfig()).map((r) => r.payload);

describe('choices', () => {
  it('channels declare how they show choices', () => {
    expect(WHATSAPP_CAPABILITIES.choices).toEqual({ buttons: 3, list: 10 });
    expect(TWILIO_WHATSAPP_CAPABILITIES.choices).toBeUndefined();
    expect(WEBCHAT_CAPABILITIES.choices).toEqual({ buttons: 10, list: 0 });
    expect(choicesPresentation(question(3), WHATSAPP_CAPABILITIES)).toBe('buttons');
    expect(choicesPresentation(question(7), WHATSAPP_CAPABILITIES)).toBe('list');
    expect(choicesPresentation(question(3), TWILIO_WHATSAPP_CAPABILITIES)).toBe('text');
    expect(renderChoicesAsText(question(2))).toBe('What can we help with?\n\n1. Option 1\n2. Option 2');
  });

  it('WhatsApp: up to 3 options are reply buttons carrying the option ids', () => {
    expect(wa(question(2))).toEqual([
      {
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: 'What can we help with?' },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'ocso:step:v1', title: 'Option 1' } },
              { type: 'reply', reply: { id: 'ocso:step:v2', title: 'Option 2' } },
            ],
          },
        },
      },
    ]);
  });

  it('WhatsApp: 4–10 options are a list message; titles too alike once cut fall back to numbered text', () => {
    const [list] = wa(question(6));
    expect(list).toMatchObject({ type: 'interactive', interactive: { type: 'list', action: { button: 'Choose', sections: [{ rows: expect.arrayContaining([{ id: 'ocso:step:v6', title: 'Option 6' }]) }] } } });
    const alike = wa(question(4, (i) => `A very long option label number ${i}`));
    expect(alike).toEqual([{ type: 'text', body: renderChoicesAsText(question(4, (i) => `A very long option label number ${i}`)), previewUrl: false }]);
  });

  it('Twilio: numbered text (interactive messages need Content Templates there)', () => {
    const payloads = createTwilioWhatsAppAdapter(offline).render([choicesPart(question(3))], twConfig()).map((r) => r.payload);
    expect(payloads).toEqual([{ type: 'text', body: 'What can we help with?\n\n1. Option 1\n2. Option 2\n3. Option 3' }]);
  });

  it('web chat: the part reaches the widget as is (it draws the buttons)', () => {
    const part: InteractionPart = choicesPart(question(2));
    const rendered = new WebChatChannelAdapter({ now: () => new Date(), generateId: () => 'id' }).render([part], { id: 'c', kind: 'WEBCHAT', name: 'Web', settings: {}, secrets: {} });
    expect(rendered[0]?.payload).toEqual({ type: 'message', parts: [part] });
  });
});
