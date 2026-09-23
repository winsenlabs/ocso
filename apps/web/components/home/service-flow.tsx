'use client';

import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import type { FlowData } from '@/lib/api/home';
import { formatDuration, formatNumber, formatPercent } from '@/lib/format';
import { flowNeighbours, isHealthyStatus, namesOf, type FlowKey } from './home-model';

/** Which objects this user may open (the page decides from permissions). */
export interface FlowLinks {
  channels: boolean;
  routers: boolean;
  queues: boolean;
  agents: boolean;
}

interface Node {
  key: FlowKey;
  name: string;
  href: string | null;
  /** Upstream names ("from Web chat, WhatsApp"), the list-view stand-in for connector lines. */
  from: string | null;
  stats: string[];
  problems: string[];
  status: string | null;
}

/**
 * Live service flow (HOME decision 3): channels → routers → queues → agents
 * over the last 24h, as four lists. Hover or focus a node to light the path
 * through it; each node says what feeds it, its volume and any trouble.
 */
export function ServiceFlow({ flow, links }: { flow: FlowData; links: FlowLinks }) {
  const [active, setActive] = useState<FlowKey | null>(null);
  const neighbours = useMemo(() => flowNeighbours(flow), [flow]);
  const lit = active ? neighbours.get(active) ?? new Set<FlowKey>() : null;

  const columns = useMemo(() => buildColumns(flow, links), [flow, links]);
  const empty = columns.every((c) => c.nodes.length === 0);

  return (
    <section className="flow" aria-labelledby="flow-h">
      <div className="sec-head">
        <h2 id="flow-h">Service flow</h2>
        <span className="count">last 24h</span>
        <span className="desc">channel → router → queue → agent</span>
      </div>
      {empty ? (
        <p className="mono-sm flow-empty">No channel, router or queue yet — the flow appears once conversations have somewhere to arrive.</p>
      ) : (
        <div className={active ? 'flow-cols focusing' : 'flow-cols'} onMouseLeave={() => setActive(null)}>
          {columns.map((col) => (
            <div className="flow-col" key={col.title}>
              <h3 id={`flow-${col.title.toLowerCase()}`}>
                {col.title}
                <span className="count">{col.nodes.length}</span>
              </h3>
              {col.nodes.length ? (
                <ul aria-labelledby={`flow-${col.title.toLowerCase()}`}>
                  {col.nodes.map((n) => (
                    <li
                      key={n.key}
                      className={[
                        'flow-node',
                        n.problems.length ? 'trouble' : '',
                        active === n.key ? 'on' : lit?.has(n.key) ? 'lit' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onMouseEnter={() => setActive(n.key)}
                      onFocus={() => setActive(n.key)}
                      onBlur={() => setActive(null)}
                    >
                      <NodeBody node={n} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mono-sm">none</p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function NodeBody({ node }: { node: Node }): ReactNode {
  const title = node.href ? (
    <Link className="fn-name" href={node.href}>
      {node.name}
    </Link>
  ) : (
    <span className="fn-name">{node.name}</span>
  );
  return (
    <>
      <span className="fn-head">
        {title}
        {node.status ? <span className="fn-status">{node.status.toLowerCase()}</span> : null}
      </span>
      {node.from ? <span className="fn-from">from {node.from}</span> : null}
      <span className="fn-stats">{node.stats.join(' · ')}</span>
      {node.problems.map((p) => (
        <span className="fn-problem" key={p}>
          {p}
        </span>
      ))}
    </>
  );
}

function buildColumns(flow: FlowData, links: FlowLinks): Array<{ title: string; nodes: Node[] }> {
  const channelsById = new Map(flow.channels.map((c) => [c.id, c]));
  const routersById = new Map(flow.routers.map((r) => [r.id, r]));
  const queuesById = new Map(flow.queues.map((q) => [q.id, q]));
  const status = (s: string) => (isHealthyStatus(s) ? null : s);

  const channels: Node[] = flow.channels.map((c) => ({
    key: `c:${c.id}`,
    name: c.name,
    href: links.channels ? '/connections?tab=channels' : null,
    from: null,
    stats: [c.kind.toLowerCase(), `${formatNumber(c.conversations24h)} conv`],
    problems: c.problem ? [c.problem] : [],
    status: status(c.status),
  }));
  const routers: Node[] = flow.routers.map((r) => ({
    key: `r:${r.id}`,
    name: r.name,
    href: links.routers ? `/routers/${encodeURIComponent(r.id)}` : null,
    from: namesOf(r.channelIds, channelsById),
    stats: [`${formatNumber(r.routed24h)} routed`],
    problems: r.stuck > 0 ? [`${formatNumber(r.stuck)} stuck in routing`] : [],
    status: status(r.status),
  }));
  const queues: Node[] = flow.queues.map((q) => ({
    key: `q:${q.id}`,
    name: q.name,
    href: links.queues ? '/queues' : null,
    from: namesOf(q.routerIds, routersById),
    stats: [`${formatNumber(q.waiting)} waiting`, ...(q.oldestWaitSeconds !== null && q.waiting > 0 ? [`oldest ${formatDuration(q.oldestWaitSeconds)}`] : [])],
    problems: q.slaAtRisk > 0 ? [`${formatNumber(q.slaAtRisk)} SLA at risk`] : [],
    status: null,
  }));
  const agents: Node[] = flow.agents.map((a) => ({
    key: `a:${a.id}`,
    name: a.name,
    href: links.agents ? `/agents/${encodeURIComponent(a.id)}` : null,
    from: namesOf(a.queueIds, queuesById),
    stats: [
      `${formatNumber(a.conversations24h)} conv`,
      ...(a.containment !== null ? [`${formatPercent(a.containment, 0)} contained`] : []),
      ...(a.escalations24h > 0 ? [`${formatNumber(a.escalations24h)} escalated`] : []),
    ],
    problems: [],
    status: status(a.status),
  }));
  return [
    { title: 'Channels', nodes: channels },
    { title: 'Routers', nodes: routers },
    { title: 'Queues', nodes: queues },
    { title: 'Agents', nodes: agents },
  ];
}
