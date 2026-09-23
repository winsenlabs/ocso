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
  setupSteps: [
    'In the Meta app dashboard open WhatsApp → Configuration → Webhook and choose Edit.',
    'Paste the webhook URL above as the Callback URL.',
    'Enter the same webhook verify token you saved on this channel, then Verify and save — OCSO answers Meta’s challenge.',
    'Subscribe the webhook to the messages field (it carries delivery statuses too) and to message_template_status_update (template review results).',
    'For message templates (the only way to reach a customer 24 hours after their last message) set the WhatsApp Business Account id on this channel; the access token needs whatsapp_business_management.',
    'Send a test message to the business number; the channel card shows the last inbound time.',
  ],
  inboundWebhook: true,
  webhookSegment: 'whatsapp',
  webhookEvents: 'messages, delivery statuses, template reviews',
  embeddable: false,
  templates: META_TEMPLATE_TERMS,
};
