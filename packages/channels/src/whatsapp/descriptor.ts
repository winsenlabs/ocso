import { z } from 'zod';
import type { ChannelKindDescriptor, ChannelMark, ChannelTemplateTerms } from '../contract/descriptor.js';
import { WhatsAppSettings } from './config.js';

/** Both WhatsApp integrations (Meta Cloud API, Twilio) reach the same network, so they share one mark. */
export const WHATSAPP_MARK: ChannelMark = { code: 'WA', name: 'WhatsApp', tone: 'wa' };

/** Meta numbers variables per component and takes media-header samples only as uploads (WhatsApp Manager). */
const META_TEMPLATE_TERMS: ChannelTemplateTerms = {
  reviewer: 'WhatsApp',
  placeholderScope: 'component',
  mediaHeaderUnsupported: 'Meta needs an uploaded sample for media headers: create this one in WhatsApp Manager (it will show up here), or use a text header',
};

export const WHATSAPP_DESCRIPTOR: ChannelKindDescriptor = {
  kind: 'WHATSAPP',
  label: 'WhatsApp — Meta Cloud API',
  description:
    'Use this when your WhatsApp Business number is registered directly with Meta (no Twilio): OCSO calls the Cloud API and Meta posts messages and delivery statuses to the OCSO webhook. Add the WhatsApp Business Account id to use message templates (the only way to reach a customer 24 hours after their last message).',
  mark: WHATSAPP_MARK,
  settingsSchema: z.toJSONSchema(WhatsAppSettings, { io: 'input' }) as Record<string, unknown>,
  secrets: [
    {
      key: 'accessToken',
      label: 'Access token',
      required: true,
      hint: 'System-user access token with whatsapp_business_messaging (sending) and whatsapp_business_management (message templates) permissions.',
    },
    { key: 'appSecret', label: 'App secret', required: true, hint: 'Meta app secret; OCSO verifies every webhook signature with it.' },
    {
      key: 'verifyToken',
      label: 'Webhook verify token',
      required: true,
      hint: 'Any random string (16+ characters). Paste the same value into the webhook settings in Meta.',
      generate: 'client',
    },
  ],
  identitySetting: { label: 'number id', keys: ['phoneNumberId'] },
  setupGuide: [
    {
      title: 'Save the channel in OCSO',
      body: 'Enter the phone number id, the access token, the app secret and a webhook verify token below (Generate makes a random one), and save. The webhook URL above answers Meta only for this channel.',
      items: [
        'Phone number id: WhatsApp → API Setup in the Meta app dashboard.',
        'Access token: a system-user token (Business Settings → System users) with whatsapp_business_messaging, and whatsapp_business_management for message templates.',
        'App secret: App settings → Basic → App secret.',
      ],
      form: true,
    },
    {
      title: 'Point Meta’s webhook at OCSO',
      body: 'In the Meta app dashboard open WhatsApp → Configuration → Webhook and choose Edit. Paste the webhook URL as the Callback URL and the same verify token you saved here, then Verify and save. OCSO answers Meta’s challenge.',
      values: [{ label: 'Callback URL', value: '{{webhookUrl}}' }],
      links: [{ label: 'Meta for Developers: your apps', href: 'https://developers.facebook.com/apps' }],
      check: 'Meta accepts the Callback URL without an error.',
    },
    {
      title: 'Subscribe to the webhook fields',
      body: 'Under Webhook fields subscribe to:',
      items: ['messages (incoming messages and delivery statuses)', 'message_template_status_update (template review results)'],
    },
    {
      title: 'Set up message templates (optional)',
      body: 'Templates are the only way to reach a customer 24 hours after their last message. Set the WhatsApp Business Account id on this channel; the access token needs whatsapp_business_management.',
    },
    {
      title: 'Test',
      body: 'Activate the channel (a second person approves it), then send a message to the business number.',
      check: 'The channel card shows the last inbound time.',
    },
  ],
  troubleshooting: [
    {
      id: 'verify-failed',
      problem: 'Meta says the callback URL or verify token could not be validated',
      fix: 'Save the channel first, then paste exactly the same verify token in Meta. The Callback URL must be the https webhook URL shown here (OCSO_PUBLIC_URL must be an https origin Meta can reach).',
    },
    {
      id: 'signature-rejected',
      problem: 'Messages never arrive although the webhook verified',
      fix: 'OCSO checks every delivery with the app secret. Paste the App secret of the same Meta app whose webhook you configured, and check that the messages field is subscribed.',
    },
  ],
  inboundWebhook: true,
  webhookSegment: 'whatsapp',
  webhookEvents: 'messages, delivery statuses, template reviews',
  embeddable: false,
  templates: META_TEMPLATE_TERMS,
};
