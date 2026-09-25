'use client';

import { CopyButton } from '../copy-button';

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
