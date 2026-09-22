import { EmptyState } from '@/components/ui/empty-state';
import type { PromptDiff, PromptVersion } from '../data/agent-schemas';
import { componentLabel } from '../lib/labels';
import { diffStats, lineDiff } from '../lib/line-diff';

/** Component-by-component line diff between two versions (only changed components are returned by the API). */
export function DiffView({ diff, from, to, labels }: { diff: PromptDiff; from: PromptVersion; to: PromptVersion; labels: ReadonlyMap<string, string> }) {
  return (
    <section aria-label={`Diff v${from.version} to v${to.version}`} style={{ marginBottom: 14 }}>
      <h3 style={{ fontSize: 13, margin: '0 0 8px' }}>
        v{from.version} → v{to.version}
        <span className="mono-sm" style={{ marginLeft: 10 }}>
          {diff.length} component{diff.length === 1 ? '' : 's'} changed
        </span>
      </h3>
      {diff.length === 0 ? (
        <EmptyState size="sm" title="No component differences">
          Both versions have identical components.
        </EmptyState>
      ) : (
        diff.map((d) => {
          const lines = lineDiff(d.before, d.after);
          const stats = diffStats(lines);
          return (
            <div className="diff" key={d.key}>
              <div className="dh">
                {componentLabel(d.key, labels)}
                <span className="mono-sm">
                  +{stats.added} −{stats.removed}
                </span>
              </div>
              {lines.map((l, i) => (
                <div key={i} className={`dl ${l.kind}`}>
                  {l.text || ' '}
                </div>
              ))}
            </div>
          );
        })
      )}
    </section>
  );
}
