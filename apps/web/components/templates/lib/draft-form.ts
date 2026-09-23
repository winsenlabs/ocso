import type { MessageTemplate } from '@ocso/domain';
import { EMPTY_FORM, type BuilderForm, type CtaButton } from './builder';

/**
 * A saved draft (as the API shows it) back into the builder's form, to edit it
 * before it is submitted (PM/research/11 §4: drafts are edited freely until a
 * checker approves their submission).
 */
export function formFromTemplate(t: MessageTemplate): BuilderForm {
  const header = t.header;
  const quickReplies = t.buttons.filter((b) => b.type === 'QUICK_REPLY').map((b) => b.text);
  const ctas: CtaButton[] = t.buttons.flatMap((b): CtaButton[] =>
    b.type === 'URL' ? [{ type: 'URL' as const, text: b.text, value: b.url ?? '' }] : b.type === 'PHONE_NUMBER' ? [{ type: 'PHONE_NUMBER' as const, text: b.text, value: b.phone ?? '' }] : [],
  );
  const examples = Object.fromEntries(t.variables.filter((v) => v.part === 'body' && v.example !== undefined).map((v) => [v.placeholder, v.example!]));
  return {
    ...EMPTY_FORM,
    name: t.name,
    language: t.language,
    category: t.category ?? 'UTILITY',
    headerKind: header ? (header.format === 'LOCATION' ? 'NONE' : header.format) : 'NONE',
    headerText: header?.format === 'TEXT' ? (header.text ?? '') : '',
    headerUrl: header && header.format !== 'TEXT' ? (header.mediaUrl ?? '') : '',
    body: t.category === 'AUTHENTICATION' ? '' : t.body,
    footer: t.category === 'AUTHENTICATION' ? '' : (t.footer ?? ''),
    buttonKind: quickReplies.length ? 'QUICK_REPLY' : ctas.length ? 'CTA' : 'NONE',
    quickReplies: quickReplies.length ? quickReplies : [''],
    ctas: ctas.length ? ctas : EMPTY_FORM.ctas,
    examples,
  };
}
