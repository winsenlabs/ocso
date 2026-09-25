import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { PageHead } from '@/components/ui/page-head';
import { SecHead } from '@/components/ui/sec-head';
import { Tile, Tiles } from '@/components/ui/tile';
import { listAgents, optional } from '@/lib/api/agents';
import { loadInbox } from '@/lib/api/conversations';
import { listQueues, listSlaPolicies, type Queue } from '@/lib/api/queues';
import { listTeams } from '@/lib/api/teams';
import { formatNumber } from '@/lib/format';
import { hasPermission, requireSession } from '@/lib/session';
import { QueuesManager, type QueueRowView } from './queues-manager';
import { toWaitingRows } from './waiting-rows';
import { WaitingList } from './waiting-list';

function rowView(q: Queue): QueueRowView {
  return {
    id: q.id,
    name: q.name,
    description: q.description,
    mode: q.mode,
    autoAssignAfterSeconds: q.autoAssignAfterSeconds,
    acceptTimeoutSeconds: q.acceptTimeoutSeconds,
    requiredSkills: q.requiredSkills,
    languages: q.languages,
    preferAccountOwner: q.preferAccountOwner,
    slaPolicyId: q.slaPolicyId,
    teamIds: q.teamIds,
    agentId: q.agentId,
    attributes: q.attributes,
    businessHours: q.businessHours,
    transferTargetIds: q.transferTargetIds,
    approved: q.approval.approved,
    pending: q.approval.pending,
    waiting: q.waiting,
    oldestWaitingSince: q.oldestWaitingSince,
    onShift: q.onShift,
    members: q.members,
    breaches: q.breaches,
  };
}

/** Frontline users see the conversations they can pick up (their role's inbox scope), newest SLA pressure first. */
async function Pickup({ fractions }: { fractions: Record<string, number> }) {
  const inbox = await loadInbox({ view: 'waiting', limit: 100 });
  const rows = toWaitingRows(inbox.items);
  return (
    <>
      <SecHead
        title="Waiting for pickup"
        count={rows.length}
        desc="claim from the conversation to take it"
        actions={
          <Link className="btn tiny ghost" href="/conversations?view=waiting">
            Open in workspace
          </Link>
        }
      />
      <WaitingList rows={rows} fractions={fractions} serverNow={Date.now()} label="Conversations waiting for pickup" emptyText="No conversation is waiting for a human in the queues you can work right now." />
    </>
  );
}

/** /queues: queue configuration for leads, live pickup work for frontline users (docs/09 §2–3). */
export async function QueuesBody() {
  const session = await requireSession();
  const canManage = hasPermission(session, Permission.QUEUES_MANAGE);
  const frontline = !canManage && hasPermission(session, Permission.CONVERSATIONS_CLAIM);
  const title = frontline ? 'Pickup queue' : 'Queues';
  if (!hasPermission(session, Permission.QUEUES_READ)) {
    return (
      <>
        <PageHead title={title} />
        <NotPermitted role={session.roleLabel} />
      </>
    );
  }
  const [queues, policies, teams, agents] = await Promise.all([listQueues(), listSlaPolicies(), listTeams(), canManage ? optional(listAgents()) : Promise.resolve(null)]);
  const fractions = Object.fromEntries(queues.flatMap((q) => {
    const p = policies.find((x) => x.id === q.slaPolicyId);
    return p ? [[q.id, p.atRiskFraction] as const] : [];
  }));
  const waiting = queues.reduce((s, q) => s + q.waiting, 0);
  const breaches = queues.reduce((s, q) => s + q.breaches, 0);

  return (
    <>
      <PageHead
        title={title}
        sub={frontline ? 'Conversations waiting for a human in the queues you can work, and how each queue is routed.' : 'Routing mode, eligible teams, skills and languages, and the SLA clock per queue — with what is waiting right now.'}
      />
      <Tiles>
        <Tile label="queues" value={formatNumber(queues.length)} />
        <Tile label="waiting now" value={formatNumber(waiting)} />
        <Tile label="past pickup sla now" value={formatNumber(breaches)} {...(breaches > 0 ? { tone: 'warn' as const } : {})} />
        <Tile label="queues without sla" value={formatNumber(queues.filter((q) => !q.slaPolicyId).length)} />
      </Tiles>
      {frontline ? <Pickup fractions={fractions} /> : null}
      <div style={frontline ? { marginTop: 22 } : undefined}>
        <QueuesManager
          queues={queues.map(rowView)}
          teams={teams.map((t) => ({ value: t.id, label: t.name }))}
          policies={policies.map((p) => ({ value: p.id, label: p.name }))}
          agents={(agents ?? []).map((a) => ({ value: a.id, label: `${a.name}${a.status === 'LIVE' ? '' : ` (${a.status.toLowerCase()})`}` }))}
          canManage={canManage}
        />
      </div>
    </>
  );
}
