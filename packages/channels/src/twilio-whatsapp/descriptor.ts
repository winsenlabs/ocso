import { z } from 'zod';
import type { ChannelKindDescriptor } from '../contract/types.js';
import { TwilioWhatsAppSettings } from './config.js';

export const TWILIO_WHATSAPP_WEBHOOK_SEGMENT = 'twilio-whatsapp';

export const TWILIO_WHATSAPP_DESCRIPTOR: ChannelKindDescriptor = {
  kind: 'TWILIO_WHATSAPP',
  label: 'WhatsApp — Twilio',
  description:
    'Use this when your WhatsApp Business number is on Twilio: OCSO sends through Twilio’s Messaging API and Twilio posts incoming messages and delivery statuses to the OCSO webhook.',
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
  inboundWebhook: true,
  webhookSegment: TWILIO_WHATSAPP_WEBHOOK_SEGMENT,
  embeddable: false,
};
