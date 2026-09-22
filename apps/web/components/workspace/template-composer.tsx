'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MessageTemplate } from '@ocso/domain';
import { StatusChip } from '@/components/ui/status-chip';
import { sendTemplateAction } from '@/lib/actions/conversations';
import { useActionRunner } from './lib/use-action';
import {
  CATEGORY_LABELS,
  TemplateListResponseSchema,
  emptyValues,
  listProblemText,
  previewOf,
  searchTemplates,
  templateHint,
  trimmed,
  valueErrors,
  variableLabel,
  type TemplateListResponse,
} from './lib/template';
import { TemplatePreview } from './template-preview';

export interface TemplateComposerProps {
  conversationId: string;
  channelId: string;
  customerName: string;
  /** Resolved conversation: reopen it and send in one step. */
  reopen: boolean;
  /** Who approves this channel's templates, in its own words ("WhatsApp"); from the kind's descriptor. */
  reviewer?: string | undefined;
  onSent?: ((message: string) => void) | undefined;
}

type ListState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; list: TemplateListResponse };

function newClientMessageId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Composer "Template" mode (docs/07 §3): pick an approved message template
 * of this channel, fill every variable, check the live preview, send. The
 * only way to reach the customer after the channel's reply window closes;
 * allowed inside it too. The list loads from the API (cached ~5 min) when the
 * picker opens.
 */
export function TemplateComposer({ conversationId, channelId, customerName, reopen, reviewer = 'the provider', onSent }: TemplateComposerProps) {
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(
    async (refresh: boolean) => {
      setRefreshing(refresh);
      try {
        const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/templates${refresh ? '?refresh=true' : ''}`, { cache: 'no-store' });
        const json: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          const message = (json as { error?: { message?: string } } | null)?.error?.message ?? `Templates could not be loaded (HTTP ${res.status})`;
          setState({ status: 'error', message });
          return;
        }
        const parsed = TemplateListResponseSchema.safeParse(json);
        setState(parsed.success ? { status: 'ready', list: parsed.data } : { status: 'error', message: 'The template list came back in an unexpected shape' });
      } catch {
        setState({ status: 'error', message: 'Templates could not be loaded. Check your connection and try again.' });
      } finally {
        setRefreshing(false);
      }
    },
    [channelId],
  );
  useEffect(() => {
    void load(false);
  }, [load]);

  if (state.status === 'loading') return <p className="mono-sm tplnote">Loading this channel’s message templates…</p>;
  if (state.status === 'error') {
    return (
      <div className="alert error" role="alert">
        <span>{state.message}</span>
      </div>
    );
  }
  const { list } = state;
  const selected = list.templates.find((t) => t.id === selectedId) ?? null;
  if (selected) {
    return (
      <TemplateForm
        key={selected.id}
        template={selected}
        conversationId={conversationId}
        customerName={customerName}
        reopen={reopen}
        reviewer={reviewer}
        onBack={() => setSelectedId(null)}
        onSent={(message) => {
          setSelectedId(null);
          onSent?.(message);
        }}
      />
    );
  }
  return <TemplatePicker list={list} query={query} onQuery={setQuery} refreshing={refreshing} onRefresh={() => void load(true)} onPick={setSelectedId} reviewer={reviewer} />;
}

interface PickerProps {
  list: TemplateListResponse;
  query: string;
  onQuery: (q: string) => void;
  refreshing: boolean;
  onRefresh: () => void;
  onPick: (id: string) => void;
  reviewer?: string | undefined;
}

export function TemplatePicker({ list, query, onQuery, refreshing, onRefresh, onPick, reviewer = 'the provider' }: PickerProps) {
  const results = useMemo(() => searchTemplates(list.templates, query), [list.templates, query]);
  const approved = list.templates.filter((t) => !templateHint(t)).length;
  return (
    <div className="tplpick">
      <div className="rowsplit">
        <label className="sr-only" htmlFor="tpl-search">
          Search templates
        </label>
        <input id="tpl-search" type="search" className="tplsearch" placeholder="Search approved templates" value={query} onChange={(e) => onQuery(e.target.value)} />
        <button type="button" className="btn tiny ghost" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {list.problem ? (
        <div className="alert warn" role="alert">
          <span>{listProblemText(list.problem)}</span>
        </div>
      ) : null}
      {!list.problem && list.templates.length === 0 ? (
        <p className="mono-sm tplnote">
          No message templates on {list.channel.name} yet. A CS Lead creates them under Message templates; {reviewer} reviews each one (usually minutes, up to 24 hours).
        </p>
      ) : null}
      {list.templates.length > 0 && approved === 0 ? (
        <p className="mono-sm tplnote">None of the {list.templates.length} templates on {list.channel.name} is approved yet, so none can be sent.</p>
      ) : null}
      {results.length > 0 ? (
        <div className="toolpick" role="group" aria-label="Templates">
          {results.map((t) => (
            <TemplateOption key={t.id} template={t} onPick={onPick} />
          ))}
        </div>
      ) : list.templates.length > 0 ? (
        <p className="mono-sm tplnote">No template matches “{query}”.</p>
      ) : null}
    </div>
  );
}

function TemplateOption({ template, onPick }: { template: MessageTemplate; onPick: (id: string) => void }) {
  const hint = templateHint(template);
  return (
    <button type="button" className="tool-opt" disabled={hint !== null} aria-disabled={hint !== null} onClick={() => onPick(template.id)}>
      <span>
        <span className="tn">{template.name}</span>
        <span className="td">{template.body || template.header?.text || template.contentType}</span>
        {hint ? <span className="td tplwarn">{hint}</span> : null}
      </span>
      <span className="tplmeta">
        {template.category ? <StatusChip tone={template.category === 'MARKETING' ? 'warn' : 'accent'}>{CATEGORY_LABELS[template.category]}</StatusChip> : null}
        <span className="mono-sm">{template.language}</span>
      </span>
    </button>
  );
}

interface FormProps {
  template: MessageTemplate;
  conversationId: string;
  customerName: string;
  reopen: boolean;
  reviewer?: string | undefined;
  onBack: () => void;
  onSent: (message: string) => void;
}

export function TemplateForm({ template, conversationId, customerName, reopen, reviewer = 'the provider', onBack, onSent }: FormProps) {
  const [values, setValues] = useState(() => emptyValues(template));
  const [media, setMedia] = useState('');
  const [touched, setTouched] = useState(false);
  const clientId = useRef(newClientMessageId());
  const { pending, error, run } = useActionRunner();
  const errors = valueErrors(template, values, media);
  const preview = previewOf(template, values, media);

  const submit = () => {
    setTouched(true);
    if (Object.keys(errors).length || pending) return;
    const input = { templateId: template.id, language: template.language, variables: trimmed(values), clientMessageId: clientId.current, reopen, ...(media.trim() ? { headerMediaUrl: media.trim() } : {}) };
    void run(() => sendTemplateAction(conversationId, input)).then((ok) => {
      if (ok) onSent(`${template.name} sent to ${customerName}`);
    });
  };

  return (
    <form
      className="box tplform"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="rowsplit">
        <b className="mono" style={{ fontSize: 12 }}>
          {template.name}
        </b>
        {template.category ? <StatusChip tone={template.category === 'MARKETING' ? 'warn' : 'accent'}>{CATEGORY_LABELS[template.category]}</StatusChip> : null}
        <span className="mono-sm">{template.language}</span>
        <span className="sp" />
        <button type="button" className="btn tiny ghost" onClick={onBack} disabled={pending}>
          ← All templates
        </button>
      </div>
      <div className="tplgrid">
        <div className="tplvars">
          {template.headerMediaRequired && template.header ? (
            <Field id="tpl-media" label={`Header ${template.header.format.toLowerCase()} · public https link`} value={media} placeholder="https://…" error={touched ? errors['headerMediaUrl'] : undefined} onChange={setMedia} />
          ) : null}
          {template.variables.map((v) => (
            <Field
              key={v.key}
              id={`tpl-${v.key}`}
              label={variableLabel(v)}
              value={values[v.key] ?? ''}
              placeholder={v.example ? `e.g. ${v.example}` : 'required'}
              error={touched ? errors[v.key] : undefined}
              onChange={(value) => setValues((cur) => ({ ...cur, [v.key]: value }))}
            />
          ))}
          {template.variables.length === 0 && !template.headerMediaRequired ? <p className="mono-sm">This template has no variables: it is sent as shown.</p> : null}
        </div>
        <TemplatePreview rendered={preview} />
      </div>
      <div className="brow">
        <span className="mono-sm">{reopen ? 'reopens the conversation · you become the handler' : `sent as a template ${reviewer} approved · recorded in the timeline`}</span>
        <span className="sp" style={{ flex: 1 }} />
        {error ? (
          <span className="err" role="alert">
            {error}
          </span>
        ) : null}
        <button type="submit" className="btn tiny accent" disabled={pending}>
          {pending ? 'Sending…' : reopen ? 'Reopen and send template' : 'Send template'}
        </button>
      </div>
    </form>
  );
}

function Field({ id, label, value, placeholder, error, onChange }: { id: string; label: string; value: string; placeholder: string; error: string | undefined; onChange: (v: string) => void }) {
  return (
    <div className="fld">
      <label htmlFor={id}>{label}</label>
      <input id={id} value={value} required placeholder={placeholder} aria-invalid={error ? true : undefined} onChange={(e) => onChange(e.target.value)} maxLength={1024} />
      {error ? <span className="err">{error}</span> : null}
    </div>
  );
}
