import { draftBodyText, draftVariableNumbers, type TemplateDraft } from '@ocso/domain';

/**
 * TemplateDraft → `POST /v1/Content` body (JSON) and the WhatsApp approval
 * request (PM/research/10 §3.1, §4). The simplest content type that carries
 * the draft is chosen: twilio/text, twilio/media, twilio/quick-reply,
 * twilio/call-to-action, else whatsapp/card (text header, footer, or media
 * with buttons); authentication drafts become whatsapp/authentication.
 * Variables are numeric and their sample values are the draft's examples.
 */

/** Twilio's call-to-action body limit (twilio/call-to-action doc); longer bodies go as whatsapp/card. */
const CTA_BODY_LIMIT = 640;

type Action = { type: 'QUICK_REPLY'; title: string; id: string } | { type: 'URL'; title: string; url: string } | { type: 'PHONE_NUMBER'; title: string; phone: string };

function actionsOf(draft: TemplateDraft): Action[] {
  return draft.buttons.map((b, i) =>
    b.type === 'QUICK_REPLY' ? { type: 'QUICK_REPLY', title: b.text, id: `reply_${i + 1}` } : b.type === 'URL' ? { type: 'URL', title: b.text, url: b.url } : { type: 'PHONE_NUMBER', title: b.text, phone: b.phone },
  );
}

function contentType(draft: TemplateDraft): { type: string; spec: Record<string, unknown> } {
  const body = draft.body;
  const actions = actionsOf(draft);
  const media = draft.header && draft.header.format !== 'TEXT' ? draft.header.mediaUrl : null;
  const textHeader = draft.header?.format === 'TEXT' ? draft.header.text : null;
  const quick = actions.length > 0 && actions.every((a) => a.type === 'QUICK_REPLY');
  const card = Boolean(textHeader || draft.footer || (media && actions.length) || (!quick && actions.length && body.length > CTA_BODY_LIMIT));
  if (card) {
    return {
      type: 'whatsapp/card',
      spec: { body, ...(textHeader ? { header_text: textHeader } : {}), ...(draft.footer ? { footer: draft.footer } : {}), ...(media ? { media: [media] } : {}), ...(actions.length ? { actions } : {}) },
    };
  }
  if (media) return { type: 'twilio/media', spec: { body, media: [media] } };
  if (quick) return { type: 'twilio/quick-reply', spec: { body, actions: actions.map((a) => ({ title: a.title, id: (a as { id: string }).id })) } };
  if (actions.length) return { type: 'twilio/call-to-action', spec: { body, actions } };
  return { type: 'twilio/text', spec: { body } };
}

export interface TwilioContentCreate {
  friendly_name: string;
  language: string;
  variables: Record<string, string>;
  types: Record<string, Record<string, unknown>>;
}

export function contentCreateBody(draft: TemplateDraft): TwilioContentCreate {
  if (draft.category === 'AUTHENTICATION') {
    const minutes = draft.authentication?.codeExpirationMinutes ?? null;
    return {
      friendly_name: draft.name,
      language: draft.language,
      variables: { '1': '123456' },
      types: {
        'whatsapp/authentication': {
          add_security_recommendation: draft.authentication?.securityRecommendation !== false,
          ...(minutes ? { code_expiration_minutes: minutes } : {}),
          actions: [{ type: 'COPY_CODE', copy_code_text: 'Copy code' }],
        },
      },
    };
  }
  const variables = Object.fromEntries(draftVariableNumbers(draftBodyText(draft)).map((n) => [String(n), (draft.examples[String(n)] ?? '').trim()]));
  const { type, spec } = contentType(draft);
  return { friendly_name: draft.name, language: draft.language, variables, types: { [type]: spec } };
}

/** `POST /v1/Content/{sid}/ApprovalRequests/whatsapp` body (`allow_category_change` is response-only). */
export function approvalRequestBody(draft: TemplateDraft): { name: string; category: string } {
  return { name: draft.name, category: draft.category };
}
