import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { displayId } from '@ocso/domain';
import { idParam, type SearchParams } from '@/components/analytics/params';
import { MetricTile } from '@/components/analytics/parts';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { ControlState, controlStateKind } from '@/components/ui/control-state';
import { CellTitle, DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { KeyValue } from '@/components/ui/key-value';
import { RailCard } from '@/components/ui/rail-card';
import { SecHead } from '@/components/ui/sec-head';
import { StatusChip, type StatusTone } from '@/components/ui/status-chip';
import { Tiles } from '@/components/ui/tile';
import { loadInbox, type ConversationSummary } from '@/lib/api/conversations';
import { listReviews, loadRubric, type Review } from '@/lib/api/quality';
import { formatDateTime, formatNumber } from '@/lib/format';
import { hasPermission, requireSession } from '@/lib/session';
import type { ControlState as DomainControlState } from '@ocso/domain';
import { ReviewLauncher, type RubricView } from './review-launcher';

const GOOD = new Set(['contained', 'good handoff']);
const BAD = new Set(['missed escalation', 'wrong policy quoted', 'tool misuse']);
const tagTone = (t: string): StatusTone => (GOOD.has(t.toLowerCase()) ? 'good' : BAD.has(t.toLowerCase()) ? 'danger' : 'warn');
const WEEK_MS = 7 * 86_400_000;

function reviewColumns(zone: string): Column<Review>[] {
  return [
    { key: 'conv', header: 'Conversation', cell: (r) => <CellTitle title={<Link href={`/conversations/${r.conversationId}`}>{r.customerName ?? 'Unnamed customer'}</Link>} caption={`${r.displayId} · ${r.agent.name}`} /> },
    { key: 'reviewer', header: 'Reviewer', cell: (r) => <span className="mono-sm">{r.reviewer.name}</span> },
    { key: 'outcome', header: 'Outcome', cell: (r) => (
        <span>
          <StatusChip tone={tagTone(r.outcomeTag)}>{r.outcomeTag}</StatusChip>
          {r.notes ? <span className="mono-sm ops-note">{r.notes}</span> : null}
        </span>
      ),
    },
    { key: 'control', header: 'Control', cell: (r) => <ControlState state={controlStateKind(r.controlState as DomainControlState)} /> },
    { key: 'score', header: 'Score', cell: (r) => <span className="mono" title={Object.entries(r.rubric).map(([k, v]) => `${k} ${v}`).join(' · ')}>{r.score.toFixed(1)}</span> },
    { key: 'when', header: 'Reviewed', cell: (r) => <span className="mono-sm">{formatDateTime(r.createdAt, zone)}</span> },
  ];
}

function queueColumns(zone: string, rubric: RubricView): Column<ConversationSummary>[] {
  return [
    { key: 'conv', header: 'Conversation', cell: (c) => <CellTitle title={<Link href={`/conversations/${c.id}`}>{c.customer.name ?? 'Unnamed customer'}</Link>} caption={`${c.displayId} · ${c.agent.name}${c.channel.name ? ` · ${c.channel.name}` : ''}`} /> },
    { key: 'handled', header: 'Handled by', cell: (c) => <span className="mono-sm">{c.assignedUser ? `human · ${c.assignedUser.name}` : 'AI'}</span> },
    { key: 'disp', header: 'Disposition', cell: (c) => <span className="mono-sm">{c.disposition ?? '—'}</span> },
    { key: 'csat', header: 'CSAT', cell: (c) => <span className="mono">{c.csat === null ? '—' : formatNumber(c.csat)}</span> },
    { key: 'resolved', header: 'Resolved', cell: (c) => <span className="mono-sm">{formatDateTime(c.resolvedAt, zone)}</span> },
    { key: 'act', header: '', cell: (c) => <ReviewLauncher conversation={{ id: c.id, displayId: c.displayId, label: c.customer.name ?? c.displayId }} rubric={rubric} /> },
  ];
}

/** QA: resolved conversations waiting for a review, and reviews with an explicit rubric (docs/11 §3, design/02 "Latest reviewed conversations"). */
export async function ReviewsBody({ searchParams }: { searchParams: SearchParams }) {
  const [session, params] = await Promise.all([requireSession(), searchParams]);
  if (!hasPermission(session, Permission.REVIEWS_MANAGE)) return <NotPermitted role={session.roleLabel} />;
  const seesAll = hasPermission(session, Permission.CONVERSATIONS_READ_ALL);
  const [reviews, rubric, resolved] = await Promise.all([listReviews({ limit: 200 }), loadRubric(), seesAll ? loadInbox({ view: 'resolved', limit: 100 }) : Promise.resolve(null)]);
  const reviewed = new Set(reviews.map((r) => r.conversationId));
  const toReview = resolved ? resolved.items.filter((c) => !reviewed.has(c.id)) : [];
  const zone = session.user.deployment.timezone;
  const now = Date.now();
  const week = reviews.filter((r) => now - Date.parse(r.createdAt) <= WEEK_MS);
  const mean = week.length ? week.reduce((s, r) => s + r.score, 0) / week.length : null;
  const target = idParam(params, 'conversation');

  return (
    <>
      <Tiles>
        <MetricTile label="to review" value={resolved ? formatNumber(toReview.length) : null} definition="Resolved conversations (the 100 most recent) without a review yet." note={undefined} />
        <MetricTile label="reviewed · 7d" value={formatNumber(week.length)} definition="Reviews created in the last 7 days." note={undefined} />
        <MetricTile label="mean score · 7d" value={mean === null ? null : formatNumber(mean, 2)} definition={`Arithmetic mean of review scores created in the last 7 days. ${rubric.scoreDefinition}`} note={undefined} />
        <MetricTile label="reviews on record" value={formatNumber(reviews.length)} definition="Reviews returned by the API (latest 200)." note={undefined} />
      </Tiles>
      {target ? (
        <div className="ops-bar">
          <span className="mono-sm">Reviewing {displayId('conv', target)} from a link</span>
          <ReviewLauncher conversation={{ id: target, displayId: displayId('conv', target), label: displayId('conv', target) }} rubric={rubric} openInitially closeHref="/reviews" buttonClass="btn tiny accent" />
        </div>
      ) : null}
      <div className="row2">
        <div>
          {resolved ? (
            <>
              <SecHead title="To review" count={toReview.length} desc="recently resolved, not yet reviewed" />
              <DataTable
                label="Conversations to review"
                columns={queueColumns(zone, rubric)}
                rows={toReview}
                rowKey={(c) => c.id}
                template="minmax(0,1.6fr) minmax(0,1fr) minmax(0,0.8fr) 48px 96px 64px"
                empty={<EmptyState title="Nothing to review">Resolved conversations appear here until someone reviews them.</EmptyState>}
              />
            </>
          ) : (
            <EmptyState title="Review queue needs full conversation access">Only roles that can read every conversation get the queue of resolved conversations to review.</EmptyState>
          )}
        </div>
        <div className="rail">
          <RailCard title="Rubric">
            <KeyValue template="minmax(70px,84px) minmax(0,1fr)" items={Object.entries(rubric.criteria).map(([k, v]) => ({ k, v }))} />
            <p className="mono-sm" style={{ margin: '10px 0 0' }}>
              {rubric.scoreDefinition}
            </p>
          </RailCard>
        </div>
      </div>
      <SecHead title="Latest reviewed conversations" count={reviews.length} style={{ marginTop: 22 }} />
      <DataTable
        label="Reviewed conversations"
        columns={reviewColumns(zone)}
        rows={reviews}
        rowKey={(r) => r.id}
        template="minmax(0,1.3fr) 120px minmax(0,1.3fr) 130px 52px 110px"
        empty={<EmptyState title="No reviews yet">Review a resolved conversation against the rubric: accuracy, policy, tone and resolution, each scored 1–5.</EmptyState>}
      />
    </>
  );
}
