import { fieldLabel, valueText } from './lib/labels';

/**
 * Everything that goes live with an ACTIVATE (PM/research/11b): the whole
 * configuration the checker is approving, not only the fields that changed —
 * the prompt text in full, the tool grants, the escalation rules.
 */
export function ApprovalSnapshot({ snapshot, label = 'What goes live' }: { snapshot: Record<string, unknown> | null; label?: string }) {
  if (!snapshot) return null;
  return (
    <div className="ap-diff ap-snapshot" role="table" aria-label={label}>
      {Object.entries(snapshot).map(([key, value]) => (
        <div className="r" role="row" key={key}>
          <span className="k" role="cell">
            {fieldLabel(key)}
          </span>
          <span className="v after" role="cell">
            {isTextMap(value) ? (
              <dl className="ap-text">
                {Object.entries(value).map(([part, text]) => (
                  <div key={part}>
                    <dt className="mono-sm">{fieldLabel(part)}</dt>
                    <dd>{text || '—'}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              valueText(value)
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Prompt components: `{ role: '…', policy: '…' }`, shown as labelled text rather than JSON. */
function isTextMap(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every((v) => typeof v === 'string');
}
