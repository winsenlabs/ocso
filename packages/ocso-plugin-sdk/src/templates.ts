/**
 * Message templates, channel-neutral: content a channel's provider reviews
 * before it may be sent (e.g. WhatsApp approved templates). A channel that
 * supports templates normalizes its provider's shapes into these.
 */

export type TemplateCategory = 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';

/** DRAFT: exists at the provider but was never submitted for review. */
export type TemplateStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED' | 'DISABLED';

export type TemplateVariablePart = 'header' | 'body' | 'button';

export type TemplateHeaderFormat = 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION';

export type TemplateButtonType = 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER' | 'COPY_CODE' | 'OTP' | 'FLOW' | 'OTHER';

export interface TemplateVariable {
  /** Key of the value in a send request: global (`"1"`) or per component (`"body.1"`). */
  key: string;
  /** The name inside the braces as written in the template text. */
  placeholder: string;
  part: TemplateVariablePart;
  /** Sample value from the template definition. */
  example?: string | undefined;
}

export interface TemplateHeader {
  format: TemplateHeaderFormat;
  text?: string | undefined;
  /** Fixed media URL of the template, when known. */
  mediaUrl?: string | undefined;
}

export interface TemplateButton {
  type: TemplateButtonType;
  text: string;
  url?: string | undefined;
  phone?: string | undefined;
}

export interface MessageTemplate {
  /** The provider's template id. */
  id: string;
  name: string;
  language: string;
  category: TemplateCategory | null;
  status: TemplateStatus;
  rejectionReason: string | null;
  header: TemplateHeader | null;
  body: string;
  footer: string | null;
  buttons: TemplateButton[];
  variables: TemplateVariable[];
  /** `template`: one namespace for the whole content; `component`: per header/body/button. */
  placeholderScope: 'template' | 'component';
  /** The sender must supply the header media at send time. */
  headerMediaRequired: boolean;
  /** Provider content type (display only). */
  contentType: string | null;
  /** Set when OCSO cannot send this template; shown instead of Send. */
  unsupportedReason: string | null;
}

/** A template written in OCSO and submitted to the provider for review (already validated by OCSO). */
export interface TemplateDraft {
  name: string;
  language: string;
  category: TemplateCategory;
  /** Let the provider re-categorize instead of rejecting a mis-categorized template. */
  allowCategoryChange: boolean;
  header: { format: 'TEXT'; text: string } | { format: 'IMAGE' | 'VIDEO' | 'DOCUMENT'; mediaUrl: string } | null;
  body: string;
  footer: string | null;
  buttons: ({ type: 'QUICK_REPLY'; text: string } | { type: 'URL'; text: string; url: string } | { type: 'PHONE_NUMBER'; text: string; phone: string })[];
  /** Example value per body variable number, e.g. `{ "1": "Priya" }`. */
  examples: Record<string, string>;
  /** AUTHENTICATION only: the fixed verification-code text with a copy-code button. */
  authentication: { codeExpirationMinutes: number | null; securityRecommendation: boolean } | null;
}
