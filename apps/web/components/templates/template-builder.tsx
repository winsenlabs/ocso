'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { TEMPLATE_CATEGORIES, TEMPLATE_CATEGORY_GUIDANCE, type DraftIssue, type TemplateCategory } from '@ocso/domain';
import { TemplatePreview } from '@/components/workspace/template-preview';
import { useApprovalRequest } from '@/components/approvals/use-approval-request';
import { saveTemplateDraftAction, submitTemplateAction } from '@/lib/actions/templates';
import { AuthenticationFields, ButtonFields, HeaderFields } from './builder-parts';
import { EMPTY_FORM, LANGUAGE_SUGGESTIONS, bodyVariables, builderState, nextVariable, type BuilderForm, type TemplateRules } from './lib/builder';

const CATEGORY_TITLES: Readonly<Record<TemplateCategory, string>> = { UTILITY: 'Utility', MARKETING: 'Marketing', AUTHENTICATION: 'Authentication' };

export interface TemplateBuilderProps {
  channel: { id: string; kind: string; name: string };
  /** The kind's template terms (descriptor): who reviews, variable keys, media-header support. */
  terms: TemplateRules & { reviewer: string };
  /** Where to go after submitting or cancelling. */
  listHref: string;
  /** Editing a saved draft (never at the provider): its record and the form it fills. */
  draft?: { recordId: string; form: BuilderForm } | null;
}

/**
 * "New template" (docs/07 §3): write a message template, see it as the
 * customer will, and save it as a draft or submit it. Maker–checker
 * (PM/research/11 §4): the provider (e.g. WhatsApp) sees it only after a
 * checker approves the submission. The same rules as the API run on every
 * keystroke; advisory warnings (e.g. a utility template that reads as
 * marketing) do not block submitting.
 */
export function TemplateBuilder({ channel, terms, listHref, draft: existing = null }: TemplateBuilderProps) {
  const router = useRouter();
  const [form, setForm] = useState<BuilderForm>(existing?.form ?? EMPTY_FORM);
  // Once saved, later saves edit the same draft (never a second one).
  const [recordId, setRecordId] = useState<string | null>(existing?.recordId ?? null);
  const approval = useApprovalRequest();
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const patch = (next: Partial<BuilderForm>) => setForm((cur) => ({ ...cur, ...next }));
  const state = useMemo(() => builderState(form, terms), [form, terms]);
  const auth = form.category === 'AUTHENTICATION';
  const variables = auth ? [] : bodyVariables(form.body);

  const save = (thenSubmit: boolean) => {
    setTouched(true);
    setError(null);
    if (!state.draft || (thenSubmit && state.check.problems.length)) return;
    const draft = state.draft;
    start(async () => {
      const result = await saveTemplateDraftAction(channel.id, draft, recordId ?? undefined);
      if (!result.ok) return setError(result.message);
      setRecordId(result.recordId);
      if (!thenSubmit) return router.push(`${listHref}&drafted=${encodeURIComponent(result.name)}`);
      approval.run({ objectKind: 'message_template', objectId: result.recordId, title: `Submit template ${result.name}` }, (choice) => submitTemplateAction(channel.id, result.recordId, choice), {
        always: true,
      });
    });
  };
  useEffect(() => {
    if (approval.outcome) router.push(`${listHref}&submitted=${encodeURIComponent(form.name)}`);
  }, [approval.outcome, form.name, listHref, router]);

  return (
    <div className="tpl-builder">
      <form
        className="form"
        noValidate
        aria-label="New message template"
        onSubmit={(e) => {
          e.preventDefault();
          save(true);
        }}
      >
        <div className="fld-row">
          <div className="fld">
            <label htmlFor="tb-name">Name</label>
            <input id="tb-name" value={form.name} onChange={(e) => patch({ name: e.target.value.toLowerCase().replace(/[\s-]+/g, '_') })} placeholder="payment_reminder" maxLength={512} />
            <span className="hint">lower-case letters, digits and underscores</span>
          </div>
          <div className="fld">
            <label htmlFor="tb-language">Language</label>
            <input id="tb-language" list="tb-languages" value={form.language} onChange={(e) => patch({ language: e.target.value })} placeholder="en" />
            <datalist id="tb-languages">
              {LANGUAGE_SUGGESTIONS.map((code) => (
                <option key={code} value={code} />
              ))}
            </datalist>
          </div>
        </div>
        <div className="fld">
          <label htmlFor="tb-category">Category</label>
          <select id="tb-category" value={form.category} onChange={(e) => patch({ category: e.target.value as TemplateCategory })}>
            {TEMPLATE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_TITLES[c]}
              </option>
            ))}
          </select>
          <p className="guide">{TEMPLATE_CATEGORY_GUIDANCE[form.category]}</p>
        </div>

        {auth ? (
          <AuthenticationFields form={form} patch={patch} />
        ) : (
          <>
            <HeaderFields form={form} patch={patch} />
            <div className="fld">
              <label htmlFor="tb-body">Message</label>
              <textarea id="tb-body" rows={5} value={form.body} maxLength={1024} onChange={(e) => patch({ body: e.target.value })} placeholder="Hi {{1}}, your payment of {{2}} is due on the 5th." />
              <span className="rowsplit">
                <span className="hint">{form.body.length}/1024 · {'{{1}}'}, {'{{2}}'}… are filled in when an exec sends it</span>
                <span className="sp" />
                <button type="button" className="btn tiny ghost" onClick={() => patch({ body: `${form.body}${form.body && !form.body.endsWith(' ') ? ' ' : ''}${nextVariable(form.body)}` })}>
                  + Variable
                </button>
              </span>
            </div>
            {variables.length ? (
              <div className="fld-row">
                {variables.map((n) => (
                  <div className="fld" key={n}>
                    <label htmlFor={`tb-ex-${n}`}>Example for {`{{${n}}}`}</label>
                    <input id={`tb-ex-${n}`} value={form.examples[String(n)] ?? ''} maxLength={200} onChange={(e) => patch({ examples: { ...form.examples, [String(n)]: e.target.value } })} placeholder="what a real value looks like" />
                  </div>
                ))}
              </div>
            ) : null}
            <div className="fld">
              <label htmlFor="tb-footer">Footer (optional)</label>
              <input id="tb-footer" value={form.footer} maxLength={60} onChange={(e) => patch({ footer: e.target.value })} placeholder="Meridian Bank · reply STOP to opt out" />
            </div>
            <ButtonFields form={form} patch={patch} />
          </>
        )}

        <label className="pass">
          <input type="checkbox" checked={form.allowCategoryChange} onChange={(e) => patch({ allowCategoryChange: e.target.checked })} />
          let {terms.reviewer} re-categorize it instead of rejecting it
        </label>

        <Issues items={touched ? state.check.problems : []} tone="err" />
        <Issues items={state.check.warnings} tone="warn" />
        {error || approval.error ? (
          <div className="alert error" role="alert">
            <span>{error ?? approval.error}</span>
          </div>
        ) : null}
        <span className="rowsplit">
          <button type="submit" className="btn accent" disabled={pending || approval.pending}>
            {pending ? 'Saving…' : 'Save and submit for approval'}
          </button>
          <button type="button" className="btn" disabled={pending || approval.pending} onClick={() => save(false)}>
            Save draft
          </button>
          <Link className="btn ghost" href={listHref}>
            Cancel
          </Link>
          <span className="mono-sm">
            a checker approves it first; then {terms.reviewer} reviews it (usually minutes, up to 24 hours) · sent via {channel.name}
          </span>
        </span>
      </form>
      {approval.modal}
      <TemplatePreview rendered={state.preview} caption="Preview with your example values" />
    </div>
  );
}

function Issues({ items, tone }: { items: DraftIssue[]; tone: 'err' | 'warn' }) {
  if (!items.length) return null;
  return (
    <ul className={`issues ${tone}`} role={tone === 'err' ? 'alert' : 'status'} aria-label={tone === 'err' ? 'Fix before submitting' : 'Review warnings'}>
      {items.map((i, n) => (
        <li key={n}>{i.message}</li>
      ))}
    </ul>
  );
}
