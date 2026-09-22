import { z } from 'zod';

/**
 * WhatsApp message templates, channel-neutral (docs/07 §3, PM/research/10).
 * Outside the 24-hour customer-service window a business may only send a
 * template the provider (Twilio Content API / Meta WhatsApp Manager) has
 * approved. Adapters normalize provider shapes into these types; the API,
 * the workspace and the template builder only ever see these.
 */

export const TEMPLATE_CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/** DRAFT: exists at the provider but was never submitted for WhatsApp approval. */
export const TEMPLATE_STATUSES = ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED'] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export const TEMPLATE_VARIABLE_PARTS = ['header', 'body', 'button'] as const;
export type TemplateVariablePart = (typeof TEMPLATE_VARIABLE_PARTS)[number];

export const TEMPLATE_HEADER_FORMATS = ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION'] as const;
export const TEMPLATE_BUTTON_TYPES = ['QUICK_REPLY', 'URL', 'PHONE_NUMBER', 'COPY_CODE', 'OTP', 'FLOW', 'OTHER'] as const;
export type TemplateButtonType = (typeof TEMPLATE_BUTTON_TYPES)[number];

export const TemplateVariableSchema = z.object({
  /**
   * Key of the value in a send request. Twilio variables are global to the
   * content (`"1"`); Meta numbers them per component (`"body.1"`,
   * `"header.1"`, `"button.0.1"`).
   */
  key: z.string().min(1).max(80),
  /** The name inside the braces as written in the template text (`1`, `order_id`). */
  placeholder: z.string().min(1).max(64),
  part: z.enum(TEMPLATE_VARIABLE_PARTS),
  /** Sample value from the template definition, shown as the input placeholder. */
  example: z.string().optional(),
});
export type TemplateVariable = z.infer<typeof TemplateVariableSchema>;

export const TemplateHeaderSchema = z.object({
  format: z.enum(TEMPLATE_HEADER_FORMATS),
  text: z.string().optional(),
  /** Fixed media URL of the template (Twilio media templates), when known. */
  mediaUrl: z.string().optional(),
});
export type TemplateHeader = z.infer<typeof TemplateHeaderSchema>;

export const TemplateButtonSchema = z.object({
  type: z.enum(TEMPLATE_BUTTON_TYPES),
  text: z.string(),
  url: z.string().optional(),
  phone: z.string().optional(),
});
export type TemplateButton = z.infer<typeof TemplateButtonSchema>;

export const MessageTemplateSchema = z.object({
  /** Provider id: Twilio Content SID (HX…) or Meta template id. */
  id: z.string().min(1),
  name: z.string(),
  language: z.string(),
  category: z.enum(TEMPLATE_CATEGORIES).nullable(),
  status: z.enum(TEMPLATE_STATUSES),
  rejectionReason: z.string().nullable(),
  header: TemplateHeaderSchema.nullable(),
  body: z.string(),
  footer: z.string().nullable(),
  buttons: z.array(TemplateButtonSchema),
  variables: z.array(TemplateVariableSchema),
  /** `template`: one namespace for the whole content (Twilio); `component`: per header/body/button (Meta). */
  placeholderScope: z.enum(['template', 'component']),
  /** The sender must supply the header media at send time (Meta media headers). */
  headerMediaRequired: z.boolean(),
  /** Provider content type, e.g. `twilio/quick-reply` (display only). */
  contentType: z.string().nullable(),
  /** Set when OCSO cannot send this template (e.g. a location header); shown instead of Send. */
  unsupportedReason: z.string().nullable(),
});
export type MessageTemplate = z.infer<typeof MessageTemplateSchema>;

/** The customer-visible sample text of a status, for badges. */
export const TEMPLATE_STATUS_LABELS: Readonly<Record<TemplateStatus, string>> = {
  DRAFT: 'not submitted',
  PENDING: 'in review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PAUSED: 'paused',
  DISABLED: 'disabled',
};

/** A template may be sent only when the provider approved it and OCSO supports its components. */
export function isTemplateSendable(template: Pick<MessageTemplate, 'status' | 'unsupportedReason'>): boolean {
  return template.status === 'APPROVED' && template.unsupportedReason === null;
}

/** Structured-part schema of a sent template message (the interaction's single part). */
export const TEMPLATE_MESSAGE_SCHEMA = 'ocso.whatsapp_template';

export const TemplateMessageDataSchema = z.object({
  templateId: z.string().min(1),
  name: z.string(),
  language: z.string(),
  category: z.enum(TEMPLATE_CATEGORIES).nullable(),
  variables: z.record(z.string(), z.string()),
  headerMediaUrl: z.string().optional(),
  /** Normalized definition at send time, so delivery sends exactly what the timeline shows. */
  template: MessageTemplateSchema,
});
export type TemplateMessageData = z.infer<typeof TemplateMessageDataSchema>;
