import Link from 'next/link';
import { AskAboutButton } from './ask-ocso-bar';
import { kindLabel, whenLabel, type NeedsYouLike } from './home-model';

const SEVERITY_WORD = { critical: 'Critical', high: 'High', normal: 'Normal' } as const;

/**
 * "Needs you" (HOME decision 1): one ranked list of what this person can act
 * on — severity, what it is, how long it has waited or when it is due, where
 * to act, and a ready question for Ask OCSO.
 */
export function NeedsYou({ items, canAsk, now = new Date(), limit = 8 }: { items: NeedsYouLike[]; canAsk: boolean; now?: Date; limit?: number }) {
  const shown = items.slice(0, limit);
  const rest = items.slice(limit);
  const critical = items.filter((i) => i.severity === 'critical').length;
  return (
    <section className="needs-you" aria-labelledby="needs-you-h">
      <div className="sec-head">
        <h2 id="needs-you-h">Needs you</h2>
        {items.length ? (
          <span className="count">
            {items.length}
            {critical ? ` · ${critical} critical` : ''}
          </span>
        ) : null}
      </div>
      {shown.length === 0 ? (
        <div className="ny-empty">
          <span className="okdot" aria-hidden="true" />
          <span>
            <b>Nothing needs you right now.</b>
            <span className="ny-empty-sub">Approvals, escalations, alerts and anything else waiting on you will appear here.</span>
          </span>
        </div>
      ) : (
        <ol className="ny-list" aria-label="Needs you, most urgent first">
          {shown.map((item) => (
            <NeedsYouRow key={item.id} item={item} canAsk={canAsk} now={now} />
          ))}
        </ol>
      )}
      {rest.length ? (
        <details className="ny-more">
          <summary>{rest.length} more</summary>
          <ol className="ny-list" start={shown.length + 1} aria-label="More that needs you">
            {rest.map((item) => (
              <NeedsYouRow key={item.id} item={item} canAsk={canAsk} now={now} />
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}

function NeedsYouRow({ item, canAsk, now }: { item: NeedsYouLike; canAsk: boolean; now: Date }) {
  const when = whenLabel(item, now);
  return (
    <li className={`ny-item ${item.severity}`}>
      <span className={`ny-sev ${item.severity}`} aria-hidden="true" />
      <div className="ny-main">
        <Link className="ny-title" href={item.href}>
          <span className="sr-only">{SEVERITY_WORD[item.severity]}: </span>
          {item.title}
        </Link>
        <span className="ny-meta">
          <span className="ny-kind">{kindLabel(item.kind)}</span>
          {item.detail ? <span className="ny-detail">{item.detail}</span> : null}
        </span>
      </div>
      {when ? (
        <time className="ny-when" dateTime={item.at}>
          {when}
        </time>
      ) : (
        <span />
      )}
      <span className="ny-actions">{canAsk && item.askOcso ? <AskAboutButton question={item.askOcso} subject={item.title} /> : null}</span>
    </li>
  );
}
