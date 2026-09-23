import { z } from 'zod';
import type { ChannelKindDescriptor } from '../contract/descriptor.js';
import { WHATSAPP_MARK } from '../whatsapp/descriptor.js';
import { TwilioWhatsAppSettings } from './config.js';

export const TWILIO_WHATSAPP_WEBHOOK_SEGMENT = 'twilio-whatsapp';

export const TWILIO_WHATSAPP_DESCRIPTOR: ChannelKindDescriptor = {
  kind: 'TWILIO_WHATSAPP',
  label: 'WhatsApp — Twilio',
  description:
    'Use this when your WhatsApp Business number is on Twilio: OCSO sends through Twilio’s Messaging API and Twilio posts incoming messages and delivery statuses to the OCSO webhook.',
  mark: WHATSAPP_MARK,
  settingsSchema: z.toJSONSchema(TwilioWhatsAppSettings, { io: 'input' }) as Record<string, unknown>,
  secrets: [
    {
      key: 'authToken',
      label: 'Auth token',
      required: true,
      hint: 'Twilio Console → Account info. Twilio signs every webhook with it (even when you send with an API key), so OCSO needs it to verify them.',
    },
    {
      key: 'apiKeySecret',
      label: 'API key secret',
      required: false,
      hint: 'Only with an API key SID: its secret, used for sending and media downloads instead of the auth token.',
    },
  ],
  identitySetting: { label: 'sender', keys: ['from', 'messagingServiceSid'] },
  setupSteps: [
    'In the Twilio Console open Messaging → Senders → WhatsApp senders and edit your sender (sending through a Messaging Service: its Integration settings; testing with the Sandbox: WhatsApp sandbox settings).',
    'Paste the webhook URL above as the webhook for incoming messages, method HTTP POST, exactly as shown (no trailing slash) — Twilio signs that exact URL.',
    'Paste the same URL as the status callback URL so delivered / read / failed statuses reach OCSO.',
    'Outside the 24-hour customer window WhatsApp only accepts approved templates. Create them in OCSO under Message templates (or in Twilio’s Content Template Builder); OCSO lists them with the same credentials and execs send them from the conversation.',
    'Send a test message to your WhatsApp number; the channel card shows the last inbound time.',
  ],
  inboundWebhook: true,
  webhookSegment: TWILIO_WHATSAPP_WEBHOOK_SEGMENT,
  webhookEvents: 'messages, delivery statuses',
  embeddable: false,
  // Twilio Content variables are global to the content (`{{1}}`); media headers carry their URL.
  templates: { reviewer: 'WhatsApp', placeholderScope: 'template' },
};
