import { describe, expect, it } from 'vitest';
import { draftAsTemplate, TemplateDraftSchema } from '@ocso/domain';
import { builderState, formToDraft } from '../../../components/templates/lib/builder';
import { formFromTemplate } from '../../../components/templates/lib/draft-form';

/** Editing a saved draft (PM/research/11 §4): the draft as the API shows it goes back into the builder unchanged. */
describe('draft → builder form', () => {
  it('round-trips header, body, footer, buttons and examples', () => {
    const draft = TemplateDraftSchema.parse({
      name: 'card_ready',
      language: 'en',
      category: 'UTILITY',
      header: { format: 'TEXT', text: 'Card ready' },
      body: 'Hi {{1}}, your card is ready at the {{2}} branch.',
      footer: 'Meridian Bank',
      buttons: [{ type: 'URL', text: 'Branches', url: 'https://bank.example/branches' }],
      examples: { '1': 'Priya', '2': 'Andheri' },
    });
    const form = formFromTemplate(draftAsTemplate(draft, { id: 'rec-1', status: 'DRAFT', scope: 'template' }));
    expect(form).toMatchObject({ name: 'card_ready', headerKind: 'TEXT', headerText: 'Card ready', footer: 'Meridian Bank', buttonKind: 'CTA', examples: { '1': 'Priya', '2': 'Andheri' } });
    expect(formToDraft(form)).toMatchObject({ header: draft.header, body: draft.body, footer: draft.footer, buttons: draft.buttons, examples: draft.examples });
    expect(builderState(form, { placeholderScope: 'template' }).check.problems).toEqual([]);
  });

  it('quick replies come back as quick replies', () => {
    const draft = TemplateDraftSchema.parse({ name: 'ok', language: 'en', category: 'UTILITY', body: 'Is this you?', buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }, { type: 'QUICK_REPLY', text: 'No' }] });
    expect(formFromTemplate(draftAsTemplate(draft, { id: 'r', status: 'DRAFT', scope: 'template' }))).toMatchObject({ buttonKind: 'QUICK_REPLY', quickReplies: ['Yes', 'No'] });
  });
});
