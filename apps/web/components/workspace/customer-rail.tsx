import Link from 'next/link';
import { Avatar } from '@/components/ui/avatar';
import { CONTROL_STATE_LABELS, controlStateKind } from '@/components/ui/control-state';
import { RiskBadge } from '@/components/ui/risk-badge';
import type { ConversationDetail, ConversationTools, CustomerProfile, TimelineItem } from '@/lib/api/conversations';
import { formatDateTime, formatTime, initials } from '@/lib/format';
import { riskOf } from './lib/timeline';
import type { ConversationTags } from './lib/use-conversation-tags';
import { TagsCard } from './tag-editor';

export interface CustomerRailProps {
  detail: ConversationDetail;
  customer: CustomerProfile | null;
  timeline: TimelineItem[];
  tools: ConversationTools;
  meId: string;
  timeZone: string;
  tags: ConversationTags;
  canTag: boolean;
}

const MODE: Readonly<Record<string, string>> = { OPEN_PICKUP: 'Open pickup', AUTO_ASSIGN: 'Auto-assign' };

/** Context rail (design/01 right): only what the API returns about this customer and conversation. */
export function CustomerRail({ detail, customer, timeline, tools, meId, timeZone, tags, canTag }: CustomerRailProps) {
  const name = detail.customer.name ?? customer?.displayName ?? detail.customer.identities[0]?.value ?? 'Unknown customer';
  const identities = customer?.identities.map((i) => ({ kind: i.kind, value: i.display ?? '', verified: i.verified })) ?? detail.customer.identities.map((i) => ({ ...i, verified: false }));
  const facts = Object.entries(customer?.attributes ?? detail.customer.attributes).filter(([, v]) => v !== null && typeof v !== 'object');
  const previous = (customer?.conversations ?? []).filter((c) => c.id !== detail.id).slice(0, 5);
  const changes = timeline.filter((i): i is Extract<TimelineItem, { kind: 'system' }> => i.kind === 'system').slice(-5).reverse();
  const handling = detail.assignedUser ? `${detail.assignedUser.name}${detail.assignedUser.id === meId ? ' (you)' : ''}` : null;

  return (
    <aside className="rail2" aria-label="Customer context">
      <section className="rcard" aria-label="Customer">
        <h3>Customer</h3>
        <div className="rowsplit" style={{ gap: 9 }}>
          <Avatar initials={(detail.customer.name ?? customer?.displayName) ? initials(name) : 'CU'} />
          <span>
            <b style={{ fontSize: 13 }}>{name}</b>
            <br />
            <span className="mono-sm">
              {[customer?.externalRef, customer ? `since ${formatDateTime(customer.createdAt, timeZone).slice(0, 6)}` : null].filter(Boolean).join(' · ') || 'no customer reference'}
            </span>
          </span>
        </div>
        <div className="rkv">
          {identities.map((i) => (
            <Pair key={`${i.kind}:${i.value}`} k={i.kind.replace(/_/g, ' ').toLowerCase()} v={`${i.value}${i.verified ? ' · verified' : ''}`} />
          ))}
          {detail.customer.language ? <Pair k="language" v={detail.customer.language} /> : null}
        </div>
      </section>

      {facts.length ? (
        <section className="rcard" aria-label="Customer facts">
          <h3>Facts</h3>
          <div className="rkv">
            {facts.slice(0, 10).map(([k, v]) => (
              <Pair key={k} k={k.replace(/[_-]+/g, ' ')} v={String(v)} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="rcard" aria-label="AI summary">
        <h3>
          AI summary<span className="sp" />
          {detail.summary ? <span className="mono-sm">{formatTime(detail.summary.createdAt, timeZone)}</span> : null}
        </h3>
        {detail.openHandoff?.agentSummary || detail.summary ? (
          <>
            <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--ink-2)', whiteSpace: 'pre-wrap' }}>{detail.openHandoff?.agentSummary ?? detail.summary?.text}</div>
            <span className="mono-sm">{detail.openHandoff?.agentSummary ? `handoff summary · ${detail.agent.name}` : `rolling summary · v${detail.summary?.version}`}</span>
          </>
        ) : (
          <span className="mono-sm">No summary yet — {detail.agent.name} writes one as the conversation grows or when it asks for a human.</span>
        )}
      </section>

      <section className="rcard" aria-label="Assignment">
        <h3>Assignment</h3>
        <div className="rkv">
          <Pair k="agent" v={`${detail.agent.name} — ${detail.agent.conversationType.toLowerCase()}`} />
          {detail.promptVersion ? <Pair k="prompt" v={`v${detail.promptVersion.version}`} /> : null}
          {detail.modelProfile ? <Pair k="model" v={detail.modelProfile.name} /> : null}
          <Pair k="queue" v={detail.queue?.name ?? 'none'} />
          {detail.openHandoff ? <Pair k="handoff" v={`${MODE[detail.openHandoff.mode] ?? detail.openHandoff.mode} · ${detail.openHandoff.status.toLowerCase()}`} /> : null}
          <Pair k="handling" v={handling ?? (detail.controlState === 'AI_ACTIVE' ? detail.agent.name : 'nobody yet')} />
          <Pair k="priority" v={detail.priority} />
        </div>
      </section>

      <section className="rcard" aria-label="Approved tools">
        <h3>
          Approved tools<span className="sp" />
          <span className="mono-sm">{tools.available.length}</span>
        </h3>
        {tools.available.length === 0 ? <span className="mono-sm">No tools approved for your role.</span> : null}
        {tools.available.slice(0, 6).map((t) => (
          <div className="tool-opt" key={t.id}>
            <span>
              <span className="tn">{t.name}</span>
              <span className="td">{t.description || t.connection}</span>
            </span>
            <RiskBadge risk={riskOf(t.riskClass)} />
          </div>
        ))}
      </section>

      <section className="rcard" aria-label="Recent actions">
        <h3>Recent actions</h3>
        {changes.length === 0 ? <span className="mono-sm">No control changes yet.</span> : null}
        {changes.map((c) => (
          <div key={c.id} style={{ display: 'grid', gap: 1 }}>
            <span style={{ fontSize: 12.5, color: 'var(--ink)' }}>{c.text.split(' · control ')[0]}</span>
            <span className="mono-sm">{formatDateTime(c.at, timeZone)}</span>
          </div>
        ))}
      </section>

      {customer ? (
        <section className="rcard" aria-label="Previous conversations">
          <h3>
            Previous conversations<span className="sp" />
            <span className="mono-sm">{previous.length}</span>
          </h3>
          {previous.length === 0 ? <span className="mono-sm">This is the customer’s first conversation.</span> : null}
          {previous.map((c) => (
            <Link key={c.id} href={`/conversations/${c.id}`} className="prev">
              <span className="rowsplit" style={{ gap: 6 }}>
                <span className="mono-sm">{formatDateTime(c.openedAt, timeZone)}</span>
                <span className="sp" />
                <span className="mono-sm">{CONTROL_STATE_LABELS[controlStateKind(c.controlState)].toLowerCase()}</span>
              </span>
              <span className="sn">{c.lastPreview ?? 'no messages'}</span>
            </Link>
          ))}
        </section>
      ) : null}

      <TagsCard state={tags} canEdit={canTag} />
    </aside>
  );
}

function Pair({ k, v }: { k: string; v: string }) {
  return (
    <>
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </>
  );
}
