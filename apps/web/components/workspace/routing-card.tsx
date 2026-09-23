import type { ConversationDetail } from '@/lib/api/conversations';

const OUTCOME: Readonly<Record<string, string>> = {
  RULE: 'matched a rule',
  MODEL: 'decided by the model',
  FALLBACK: 'fallback queue',
  PASS_THROUGH: 'pass-through',
  CONTINUE: 'customer continued',
  TIMEOUT: 'no answer — fallback',
  NEW: 'customer started a new conversation',
  TRANSFER: 'transferred',
};

const PHASE: Readonly<Record<string, string>> = { RETURNING: 'asking continue or new', STEPS: 'asking the menu', DONE: 'decided' };

/**
 * Routing card (PM/research/11 §5.7, right rail): which router placed this
 * conversation, how (outcome and the deciding rule), and the attributes and
 * answers it collected. Absent for conversations from before routing.
 */
export function RoutingCard({ detail }: { detail: ConversationDetail }) {
  const r = detail.routing;
  if (!r) return null;
  const deciding = detail.controlState === 'ROUTING';
  const attributes = Object.entries(r.attributes);
  const answers = Object.entries(r.answers);
  return (
    <section className="rcard" aria-label="Routing">
      <h3>
        Routing<span className="sp" />
        {deciding ? <span className="schip accent">routing</span> : null}
      </h3>
      <div className="rkv">
        <span className="k">router</span>
        <span className="v">{r.router ? `${r.router.name}${r.routerVersion ? ` · v${r.routerVersion}` : ''}` : 'deleted router'}</span>
        <span className="k">{deciding ? 'now' : 'outcome'}</span>
        <span className="v">{deciding ? (PHASE[r.phase] ?? r.phase.toLowerCase()) : r.outcome ? (OUTCOME[r.outcome] ?? r.outcome.toLowerCase()) : 'not decided'}</span>
        {r.rule ? (
          <>
            <span className="k">rule</span>
            <span className="v">{`${(r.ruleIndex ?? 0) + 1}. ${r.rule}`}</span>
          </>
        ) : null}
        {detail.queue ? (
          <>
            <span className="k">queue</span>
            <span className="v">{detail.queue.name}</span>
          </>
        ) : null}
        {attributes.map(([k, v]) => (
          <span key={`a-${k}`} style={{ display: 'contents' }}>
            <span className="k">{k}</span>
            <span className="v">{v}</span>
          </span>
        ))}
      </div>
      {answers.length ? <span className="mono-sm">answers: {answers.map(([k, v]) => `${k} → ${v}`).join(' · ')}</span> : null}
    </section>
  );
}
