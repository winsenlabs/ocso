'use client';

import { CopyButton } from '../copy-button';
import { renderSetupFile, type SetupFileDef } from './settings-form';

/**
 * What the admin does in the provider's console after saving a channel: the
 * steps come from the kind's descriptor (GET /v1/channels/kinds `setupSteps`),
 * so a new channel plugin brings its own instructions.
 */
export function ProviderSteps({ steps, fallback }: { steps: readonly string[]; fallback: string }) {
  if (!steps.length) return <p className="mono-sm">{fallback}</p>;
  return (
    <ol className="setup-steps">
      {steps.map((step, i) => (
        <li key={i}>{step}</li>
      ))}
    </ol>
  );
}

/**
 * Secrets generated in this dialog for the admin to paste elsewhere (e.g. a
 * webhook verify token into the provider's console), shown once after saving.
 */
export function GeneratedSecrets({ secrets }: { secrets: ReadonlyArray<{ label: string; value: string }> }) {
  if (!secrets.length) return null;
  return (
    <p className="mono-sm">
      Generated in this dialog, shown only now:{' '}
      {secrets.map((s, i) => (
        <span key={s.label}>
          {i ? ' · ' : null}
          {s.label} <code className="mono">{s.value}</code>
        </span>
      ))}
    </p>
  );
}

/**
 * Keys OCSO generated on create that the admin must copy elsewhere (the descriptor marks them `reveal: once`,
 * e.g. the web chat secret key for the site's backend). Shown only in this dialog; never again.
 */
export function RevealedSecrets({ secrets }: { secrets: ReadonlyArray<{ key: string; label: string; value: string }> }) {
  if (!secrets.length) return null;
  return (
    <section className="conn-fieldset" aria-label="Keys shown once">
      <span className="legend">Copy now · shown once</span>
      {secrets.map((s) => (
        <div key={s.key} className="generated-secret" role="status">
          <span className="mono-sm">{s.label}</span>
          <code className="secret-once" aria-label={`${s.label} (shown once)`}>
            {s.value}
          </code>
          <CopyButton value={s.value} what={s.label} />
        </div>
      ))}
      <p className="mono-sm">Keep it on your server. OCSO stores it by reference and never shows it again; rotate it from the channel’s Edit dialog.</p>
    </section>
  );
}

/**
 * Files the kind's descriptor provides for the provider's console (a Slack or Teams app manifest), filled
 * from the saved channel: copy or download. Placeholders a value could not fill stay visible, with a note.
 */
export function SetupFiles({ files, webhookUrl, settings }: { files: readonly SetupFileDef[]; webhookUrl: string | null; settings: Record<string, unknown> }) {
  if (!files.length) return null;
  return (
    <>
      {files.map((file) => {
        const { content, missing } = renderSetupFile(file, { webhookUrl, settings });
        return (
          <div key={file.key} className="setup-file" aria-label={file.label}>
            <div className="rowsplit">
              <span className="mono-sm">
                {file.label} · <code className="mono">{file.filename}</code>
              </span>
              <span className="sp" />
              <CopyButton value={content} what={file.label} />
              <button type="button" className="btn tiny" aria-label={`Download ${file.label}`} onClick={() => download(file.filename, file.contentType, content)}>
                Download
              </button>
            </div>
            {file.description ? <p className="mono-sm">{file.description}</p> : null}
            {missing.length ? (
              <p className="mono-sm" role="note">
                Fill in {missing.map((m) => m.replace(/^settings\./, '')).join(', ')} before using this file (set it on the channel, or edit the placeholders).
              </p>
            ) : null}
            <pre className="setup-file-body" tabIndex={0}>
              {content}
            </pre>
          </div>
        );
      })}
    </>
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
