import { z } from 'zod';
import type { ChannelKindDescriptor } from '../contract/types.js';
import { WhatsAppSettings } from './config.js';

export const WHATSAPP_DESCRIPTOR: ChannelKindDescriptor = {
  kind: 'WHATSAPP',
  label: 'WhatsApp — Meta Cloud API',
  description:
    'Use this when your WhatsApp Business number is registered directly with Meta (no Twilio): OCSO calls the Cloud API and Meta posts messages and delivery statuses to the OCSO webhook.',
  settingsSchema: z.toJSONSchema(WhatsAppSettings, { io: 'input' }) as Record<string, unknown>,
  secrets: [
    { key: 'accessToken', label: 'Access token', required: true, hint: 'System-user access token with whatsapp_business_messaging permission.' },
    { key: 'appSecret', label: 'App secret', required: true, hint: 'Meta app secret; OCSO verifies every webhook signature with it.' },
    {
      key: 'verifyToken',
      label: 'Webhook verify token',
      required: true,
      hint: 'Any random string (16+ characters). Paste the same value into the webhook settings in Meta.',
      generate: 'client',
    },
  ],
  inboundWebhook: true,
  webhookSegment: 'whatsapp',
  embeddable: false,
};
