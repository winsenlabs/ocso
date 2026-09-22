'use client';

import type { BuilderForm, ButtonKind, CtaButton, HeaderKind } from './lib/builder';

type Patch = (patch: Partial<BuilderForm>) => void;

/** Header: none, static text, or a media sample link (image, video, document). */
export function HeaderFields({ form, patch }: { form: BuilderForm; patch: Patch }) {
  return (
    <div className="fld-row">
      <div className="fld">
        <label htmlFor="tb-header-kind">Header</label>
        <select id="tb-header-kind" value={form.headerKind} onChange={(e) => patch({ headerKind: e.target.value as HeaderKind })}>
          <option value="NONE">None</option>
          <option value="TEXT">Text</option>
          <option value="IMAGE">Image</option>
          <option value="VIDEO">Video</option>
          <option value="DOCUMENT">Document</option>
        </select>
      </div>
      {form.headerKind === 'TEXT' ? (
        <div className="fld">
          <label htmlFor="tb-header-text">Header text</label>
          <input id="tb-header-text" value={form.headerText} maxLength={60} onChange={(e) => patch({ headerText: e.target.value })} placeholder="Payment reminder" />
          <span className="hint">up to 60 characters · no variables</span>
        </div>
      ) : form.headerKind !== 'NONE' ? (
        <div className="fld">
          <label htmlFor="tb-header-url">Sample {form.headerKind.toLowerCase()} link</label>
          <input id="tb-header-url" value={form.headerUrl} onChange={(e) => patch({ headerUrl: e.target.value })} placeholder="https://cdn.example.com/statement.pdf" />
          <span className="hint">public https link · reviewers see it; the same file is sent</span>
        </div>
      ) : null}
    </div>
  );
}

/** Buttons: none, up to 10 quick replies, or call-to-action (≤ 2 website links, 1 phone number). */
export function ButtonFields({ form, patch }: { form: BuilderForm; patch: Patch }) {
  const setReply = (i: number, text: string) => patch({ quickReplies: form.quickReplies.map((r, j) => (j === i ? text : r)) });
  const setCta = (i: number, next: Partial<CtaButton>) => patch({ ctas: form.ctas.map((b, j) => (j === i ? { ...b, ...next } : b)) });
  return (
    <div className="fld">
      <label htmlFor="tb-button-kind">Buttons</label>
      <select id="tb-button-kind" value={form.buttonKind} onChange={(e) => patch({ buttonKind: e.target.value as ButtonKind })}>
        <option value="NONE">None</option>
        <option value="QUICK_REPLY">Quick replies (the customer taps an answer)</option>
        <option value="CTA">Call to action (open a website or call)</option>
      </select>
      {form.buttonKind === 'QUICK_REPLY'
        ? form.quickReplies.map((text, i) => (
            <div className="btnrow" key={i}>
              <span className="mono-sm">reply {i + 1}</span>
              <input aria-label={`Quick reply ${i + 1}`} value={text} maxLength={20} onChange={(e) => setReply(i, e.target.value)} placeholder="Yes, confirm" />
              <span />
              <button type="button" className="btn tiny ghost" aria-label={`Remove quick reply ${i + 1}`} onClick={() => patch({ quickReplies: form.quickReplies.filter((_, j) => j !== i) })} disabled={form.quickReplies.length === 1}>
                ✕
              </button>
            </div>
          ))
        : null}
      {form.buttonKind === 'CTA'
        ? form.ctas.map((b, i) => (
            <div className="btnrow" key={i}>
              <select aria-label={`Button ${i + 1} type`} value={b.type} onChange={(e) => setCta(i, { type: e.target.value as CtaButton['type'] })}>
                <option value="URL">Website</option>
                <option value="PHONE_NUMBER">Call</option>
              </select>
              <input aria-label={`Button ${i + 1} text`} value={b.text} maxLength={20} onChange={(e) => setCta(i, { text: e.target.value })} placeholder={b.type === 'URL' ? 'View statement' : 'Call us'} />
              <input
                aria-label={b.type === 'URL' ? `Button ${i + 1} link` : `Button ${i + 1} phone number`}
                value={b.value}
                onChange={(e) => setCta(i, { value: e.target.value })}
                placeholder={b.type === 'URL' ? 'https://meridian.example/statements' : '+919812341208'}
              />
              <button type="button" className="btn tiny ghost" aria-label={`Remove button ${i + 1}`} onClick={() => patch({ ctas: form.ctas.filter((_, j) => j !== i) })} disabled={form.ctas.length === 1}>
                ✕
              </button>
            </div>
          ))
        : null}
      {form.buttonKind === 'QUICK_REPLY' && form.quickReplies.length < 10 ? (
        <button type="button" className="btn tiny ghost" onClick={() => patch({ quickReplies: [...form.quickReplies, ''] })}>
          + Quick reply
        </button>
      ) : null}
      {form.buttonKind === 'CTA' && form.ctas.length < 3 ? (
        <button type="button" className="btn tiny ghost" onClick={() => patch({ ctas: [...form.ctas, { type: form.ctas.some((b) => b.type === 'PHONE_NUMBER') ? 'URL' : 'PHONE_NUMBER', text: '', value: '' }] })}>
          + Button
        </button>
      ) : null}
      <span className="hint">button text up to 20 characters · website links are fixed (no variables)</span>
    </div>
  );
}

/** Authentication: WhatsApp's fixed code text, an optional expiry, and the security line. */
export function AuthenticationFields({ form, patch }: { form: BuilderForm; patch: Patch }) {
  return (
    <div className="fld-row">
      <div className="fld">
        <label htmlFor="tb-expiry">Code expires after (minutes)</label>
        <input id="tb-expiry" inputMode="numeric" value={form.codeExpirationMinutes} onChange={(e) => patch({ codeExpirationMinutes: e.target.value.replace(/\D/g, '').slice(0, 2) })} placeholder="optional, 1–90" />
      </div>
      <label className="pass" style={{ alignSelf: 'end' }}>
        <input type="checkbox" checked={form.securityRecommendation} onChange={(e) => patch({ securityRecommendation: e.target.checked })} />
        add “do not share this code”
      </label>
    </div>
  );
}
