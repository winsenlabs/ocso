'use client';

import { useState, type ReactNode } from 'react';
import type { SetupStep } from '@/lib/api/channels';
import { CopyButton } from '../copy-button';
import { fillTemplate, renderSetupFile, safeHttpsHref, setupFileDownloadHref, type SetupContext, type SetupFileDef } from './settings-form';

interface Props {
  /** The kind's guide (descriptor `setupGuide`), in order. */
  steps: readonly SetupStep[];
  files: readonly SetupFileDef[];
  ctx: SetupContext;
  /** The saved channel (zip packages download from the API); null before it exists. */
  channelId: string | null;
  /** OCSO's own form (settings and secrets), shown inside the step marked `form`. */
  formSlot?: ReactNode;
  /** Shown in the form step when there is no form slot (e.g. after saving). */
  formNote?: string | undefined;
  label: string;
}

/**
 * The kind's setup guide as a numbered checklist: each step's instructions, values to copy (the webhook URL, the
 * scopes), setup files to copy or download, provider links and how to tell it worked. Everything comes from the
 * descriptor as plain text, so a new channel plugin brings its own guide. The ticks are the admin's own
 * checklist in this dialog (not saved).
 */
export function SetupGuide({ steps, files, ctx, channelId, formSlot, formNote, label }: Props) {
  const [done, setDone] = useState<ReadonlySet<number>>(new Set());
  if (!steps.length) return null;
  const toggle = (i: number) =>
    setDone((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  return (
    <ol className="cg-steps" aria-label={`${label} setup guide`}>
      {steps.map((step, i) => {
        const id = `cg-step-${i + 1}`;
        const stepFiles = (step.files ?? []).map((key) => files.find((f) => f.key === key)).filter((f): f is SetupFileDef => !!f);
        return (
          <li key={i} className={`cg-step${done.has(i) ? ' done' : ''}`} aria-labelledby={`${id}-title`}>
            <div className="cg-head">
              <input type="checkbox" id={`${id}-done`} className="cg-tick" checked={done.has(i)} onChange={() => toggle(i)} aria-label={`Mark step ${i + 1} done`} />
              <span className="cg-num" aria-hidden="true">
                {i + 1}
              </span>
              <span className="cg-title" id={`${id}-title`}>
                {step.title}
              </span>
            </div>
            <div className="cg-body">
              {step.body ? <p>{step.body}</p> : null}
              {step.items?.length ? (
                <ul className="cg-items">
                  {step.items.map((item, j) => (
                    <li key={j}>{item}</li>
                  ))}
                </ul>
              ) : null}
              {step.table ? (
                <div className="cg-table-wrap">
                  <table className="cg-table">
                    <thead>
                      <tr>
                        <th scope="col">{step.table.head[0]}</th>
                        <th scope="col">{step.table.head[1]}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {step.table.rows.map((row, j) => (
                        <tr key={j}>
                          <td>
                            <code className="mono">{row[0]}</code>
                          </td>
                          <td>{row[1]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {step.values?.map((v, j) => {
                const { content, missing } = fillTemplate(v.value, 'text/plain', ctx);
                return (
                  <div key={j} className="cg-value">
                    <span className="mono-sm">{v.label}</span>
                    <div className="rowsplit" style={{ flexWrap: 'nowrap' }}>
                      <code className="secret-once" aria-label={v.label}>
                        {missing.length ? 'available once the channel is saved' : content}
                      </code>
                      {missing.length ? null : <CopyButton value={content} what={v.label} />}
                    </div>
                  </div>
                );
              })}
              {stepFiles.length ? <SetupFileList files={stepFiles} ctx={ctx} channelId={channelId} /> : null}
              {step.form ? (formSlot ?? (formNote ? <p className="mono-sm">{formNote}</p> : null)) : null}
              {step.links?.length ? (
                <p className="cg-links">
                  {step.links.map((l, j) => {
                    const href = safeHttpsHref(l.href);
                    return href ? (
                      <a key={j} href={href} target="_blank" rel="noopener noreferrer">
                        {l.label} ↗
                      </a>
                    ) : null;
                  })}
                </p>
              ) : null}
              {step.check ? <p className="cg-check">✓ {step.check}</p> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Setup files offered in a guide step: text files are copied or downloaded here (filled in the browser from
 * the channel); zip packages are built by the API and downloaded through the BFF, once the values they need
 * are saved.
 */
export function SetupFileList({ files, ctx, channelId }: { files: readonly SetupFileDef[]; ctx: SetupContext; channelId: string | null }) {
  return (
    <div className="cg-files">
      {files.map((file) => {
        const { content, missing, preview } = renderSetupFile(file, ctx);
        const zip = file.contentType === 'application/zip';
        const ready = !missing.length && (!zip || channelId !== null);
        return (
          <div key={file.key} className="setup-file" role="group" aria-label={file.label}>
            <div className="rowsplit">
              <span className="mono-sm">
                {file.label} · <code className="mono">{file.filename}</code>
              </span>
              <span className="sp" />
              {zip ? null : <CopyButton value={content} what={file.label} />}
              {zip ? (
                ready ? (
                  <a className="btn tiny accent" href={setupFileDownloadHref(channelId!, file.key)} download={file.filename} aria-label={`Download ${file.label}`}>
                    Download
                  </a>
                ) : (
                  <button type="button" className="btn tiny" disabled aria-label={`Download ${file.label}`}>
                    Download
                  </button>
                )
              ) : (
                <button type="button" className="btn tiny accent" aria-label={`Download ${file.label}`} onClick={() => download(file.filename, file.contentType, content)}>
                  Download
                </button>
              )}
            </div>
            {file.description ? <p className="mono-sm">{file.description}</p> : null}
            {missing.length ? (
              <p className="mono-sm warn-text" role="note">
                {missing.includes('webhookUrl') ? 'Save the channel first: the file needs its webhook URL. ' : ''}
                {missing.filter((m) => m.startsWith('settings.')).length
                  ? `Fill in ${missing
                      .filter((m) => m.startsWith('settings.'))
                      .map((m) => m.replace(/^settings\./, ''))
                      .join(', ')} and save before using this file.`
                  : ''}
              </p>
            ) : null}
            <details className="cg-preview">
              <summary>{zip ? `Preview ${preview ?? 'contents'} (inside the zip, with its icons)` : `Preview ${file.filename}`}</summary>
              <pre className="setup-file-body" tabIndex={0} aria-label={`${file.label} contents`}>
                {content}
              </pre>
            </details>
          </div>
        );
      })}
    </div>
  );
}

/** Known problems and their fixes; connection checks link to an entry by id (`#ts-<id>`). */
export function Troubleshooting({ entries, open, onToggle }: { entries: ReadonlyArray<{ id: string; problem: string; fix: string }>; open: boolean; onToggle: (open: boolean) => void }) {
  if (!entries.length) return null;
  return (
    <details className="conn-fieldset cg-trouble" id="troubleshooting" open={open} onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="legend">Troubleshooting · {entries.length} known problems</summary>
      <dl className="cg-trouble-list">
        {entries.map((t) => (
          <div key={t.id} id={`ts-${t.id}`} className="cg-trouble-item" tabIndex={-1}>
            <dt>{t.problem}</dt>
            <dd>{t.fix}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** What happens when a webhook kind is added: a draft first (for its webhook URL), then the guide, the credentials, activation. */
export function SetupPlan({ kind, label }: { kind: { setupGuide: readonly SetupStep[]; setupFiles: readonly SetupFileDef[]; secrets: ReadonlyArray<{ label: string; generate?: string | undefined }> }; label: string }) {
  const secretLabels = kind.secrets.filter((f) => f.generate !== 'server').map((f) => f.label.toLowerCase());
  return (
    <section className="conn-fieldset" aria-label={`How setting up ${label} works`}>
      <span className="legend">How setting up {label} works</span>
      <ol className="cg-plan">
        <li>
          <strong>Create a draft now.</strong> OCSO gives it its webhook URL, which {label} needs before it hands out credentials. A draft receives nothing, so you can change it freely.
        </li>
        <li>
          <strong>Follow the {kind.setupGuide.length}-step guide</strong> for {label}
          {kind.setupFiles.length ? <>, with {kind.setupFiles.map((f) => f.label).join(' and ')} ready to download, filled with this channel’s values</> : null}.
        </li>
        {secretLabels.length ? (
          <li>
            <strong>Paste the {secretLabels.join(', ')}</strong> into the form inside the guide and save. Secrets are write-only.
          </li>
        ) : null}
        <li>
          <strong>Test the connection, then activate.</strong> A second person approves the activation.
        </li>
      </ol>
      <details className="cg-preview">
        <summary>See all {kind.setupGuide.length} steps</summary>
        <ol className="cg-plan-steps">
          {kind.setupGuide.map((step, i) => (
            <li key={i}>{step.title}</li>
          ))}
        </ol>
      </details>
    </section>
  );
}

function download(filename: string, contentType: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: `${contentType};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
