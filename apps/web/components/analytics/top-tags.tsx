import Link from 'next/link';
import { EmptyState } from '@/components/ui/empty-state';
import { ChartCard } from '@/components/ui/rail-card';
import type { Overview } from '@/lib/api/analytics';
import { formatNumber, formatPercent, share } from './metrics';
import { Fn } from './parts';

/**
 * Most used staff tags on cohort conversations (definition `tags`). Each tag
 * opens the workspace inbox filtered by it.
 */
export function TopTags({ tags, conversations, refs }: { tags: Overview['tags']; conversations: number; refs: Record<string, number> }) {
  const max = Math.max(0, ...tags.items.map((t) => t.count));
  return (
    <ChartCard
      title="Top tags"
      meta={
        <>
          <span className="mono-sm">
            {formatNumber(tags.tagged)} tagged{conversations > 0 ? ` · ${formatPercent(tags.tagged / conversations, 0)}` : ''}
          </span>
          <Fn n={refs['tags']} />
        </>
      }
    >
      {tags.items.length ? (
        <div className="hb" style={{ gridTemplateColumns: 'minmax(90px,1fr) minmax(0,1.6fr) 44px' }} role="list" aria-label="Top tags in the window">
          {tags.items.slice(0, 8).map((t) => (
            <div key={t.tag} role="listitem" style={{ display: 'contents' }}>
              <Link href={`/conversations?tag=${encodeURIComponent(t.tag)}`} title={`Open the inbox filtered by “${t.tag}”`}>
                {t.tag}
              </Link>
              <span className="bar" aria-hidden="true">
                <i className="a" style={{ width: `${Math.round(share(t.count, max) * 100)}%` }} />
              </span>
              <span className="n">{formatNumber(t.count)}</span>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState size="sm" title="No tagged conversations in the window">
          Tags added in the workspace or on resolve appear here, most used first.
        </EmptyState>
      )}
    </ChartCard>
  );
}
