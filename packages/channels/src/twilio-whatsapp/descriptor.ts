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
  setupGuide: [
    {
      title: 'Save the channel in OCSO',
      body: 'Enter your Account SID, the WhatsApp sender (or Messaging Service SID) and the auth token below, and save.',
      items: ['Account SID and auth token: Twilio Console → Account info.', 'Sending with an API key: add its SID in the settings and its secret below; the auth token is still needed to verify Twilio’s webhooks.'],
      form: true,
    },
    {
      title: 'Point your WhatsApp sender at OCSO',
      body: 'In the Twilio Console open Messaging → Senders → WhatsApp senders and edit your sender (a Messaging Service: its Integration settings; the Sandbox: WhatsApp sandbox settings). Paste the webhook URL for incoming messages, method HTTP POST, exactly as shown: Twilio signs that exact URL, so no trailing slash.',
      values: [{ label: 'Webhook URL', value: '{{webhookUrl}}' }],
      links: [{ label: 'Twilio Console', href: 'https://console.twilio.com/' }],
    },
    {
      title: 'Set the status callback',
      body: 'Paste the same URL as the status callback URL, so delivered, read and failed statuses reach OCSO.',
      values: [{ label: 'Status callback URL', value: '{{webhookUrl}}' }],
    },
    {
      title: 'Message templates',
      body: 'Outside the 24-hour customer window WhatsApp only accepts approved templates. Create them in OCSO under Message templates (or in Twilio’s Content Template Builder); OCSO lists them with the same credentials.',
    },
    {
      title: 'Test',
      body: 'Use Test connection below, activate the channel (a second person approves it), then send a message to your WhatsApp number.',
      check: 'The channel card shows the last inbound time.',
    },
  ],
  troubleshooting: [
    {
      id: 'signature-rejected',
      problem: 'Twilio’s requests are refused (403) or messages never arrive',
      fix: 'Twilio signs the exact URL it calls: paste the webhook URL exactly as shown (https, no trailing slash, no extra query). The auth token must be the account’s current primary token, even when you send with an API key.',
    },
  ],
  inboundWebhook: true,
  webhookSegment: TWILIO_WHATSAPP_WEBHOOK_SEGMENT,
  webhookEvents: 'messages, delivery statuses',
  embeddable: false,
  // Twilio Content variables are global to the content (`{{1}}`); media headers carry their URL.
  templates: { reviewer: 'WhatsApp', placeholderScope: 'template' },
};
