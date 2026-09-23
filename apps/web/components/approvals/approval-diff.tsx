import { fieldLabel, valueText } from './lib/labels';
import type { DiffField } from './lib/schemas';

/** Before/after of a proposal, one row per changed field (the diff the API froze on the decision). */
export function ApprovalDiff({ fields, label = 'Proposed change' }: { fields: DiffField[]; label?: string }) {
  if (!fields.length) return <span className="mono-sm">No field changes (the action itself is the change).</span>;
  return (
    <div className="ap-diff" role="table" aria-label={label}>
      <div className="r" role="row">
        <span className="h" role="columnheader">
          Field
        </span>
        <span className="h" role="columnheader">
          Before
        </span>
        <span className="h" role="columnheader">
          After
        </span>
      </div>
      {fields.map((f) => (
        <div className="r" role="row" key={f.path}>
          <span className="k" role="cell">
            {fieldLabel(f.path)}
            <span className="mark">{f.change}</span>
          </span>
          <span className="v before" role="cell">
            {valueText(f.before)}
          </span>
          <span className="v after" role="cell">
            {valueText(f.after)}
          </span>
        </div>
      ))}
    </div>
  );
}
