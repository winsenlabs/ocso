import { notFound } from 'next/navigation';
import { Permission } from '@ocso/auth';
import { PendingBadge } from '@/components/approvals/pending-badge';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { PageHead } from '@/components/ui/page-head';
import { StatusChip } from '@/components/ui/status-chip';
import { listAgents, optional } from '@/lib/api/agents';
import { listChannels } from '@/lib/api/channels';
import { ApiError } from '@/lib/api/errors';
import { listProfiles } from '@/lib/api/models';
import { listQueues } from '@/lib/api/queues';
import { getRouter, listRouters } from '@/lib/api/routers';
import { loadTemplateChannels } from '@/lib/api/templates';
import { hasPermission, requireSession } from '@/lib/session';
import { KIND_LABELS } from './lib/definition';
import { RouterBuilder } from './router-builder';
import { ChannelsPanel, RouterActions, VersionsPanel } from './router-panels';
import type { QueueChoice } from './rules-editor';
import { SimulatePanel } from './simulate-panel';

const orNull = async <T,>(p: Promise<T>): Promise<T | null> => optional(p);

/**
 * /routers/[id] (PM/research/11 §5.7): the builder for the draft, versions and
 * activation through approval, the channels it routes, and the simulator.
 */
export async function RouterDetailBody({ id }: { id: string }) {
  const session = await requireSession();
  if (!hasPermission(session, Permission.ROUTERS_READ)) {
    return (
      <>
        <PageHead title="Router" />
        <NotPermitted role={session.roleLabel} />
      </>
    );
  }
  const canManage = hasPermission(session, Permission.ROUTERS_MANAGE);
  let router;
  try {
    router = await getRouter(id);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }
  const has = (p: Permission) => hasPermission(session, p);
  const [queues, agents, channels, routers, profiles, templateChannels] = await Promise.all([
    has(Permission.QUEUES_READ) ? listQueues() : Promise.resolve([]),
    orNull(listAgents()),
    has(Permission.CHANNELS_READ) ? orNull(listChannels()) : Promise.resolve(null),
    listRouters(),
    orNull(listProfiles()),
    has(Permission.MESSAGE_TEMPLATES_MANAGE) ? orNull(loadTemplateChannels()) : Promise.resolve(null),
  ]);
  const agentName = new Map((agents ?? []).map((a) => [a.id, a.name]));
  const choices: QueueChoice[] = queues.map((q) => ({ id: q.id, name: q.name, attributes: q.attributes, agentName: q.agentId ? (agentName.get(q.agentId) ?? 'an agent') : null, approved: q.approval.approved }));
  const attached = router.channels.map((c) => c.id);
  // Templates can be made for the channels this router routes whose kind has provider templates.
  const templateTargets = (templateChannels ?? []).filter((c) => attached.includes(c.id)).map((c) => ({ id: c.id, name: c.name }));
  const routerOf = new Map(routers.flatMap((r) => r.channels.map((c) => [c.id, r.name] as const)));
  const draft = router.draft?.definition ?? router.activeDefinition;

  return (
    <>
      <PageHead
        title={router.name}
        sub={router.description || 'channel → router → queue → agent'}
        actions={<RouterActions routerId={router.id} name={router.name} status={router.status} canManage={canManage} />}
      />
      <div className="rowsplit rt-facts" style={{ gap: 8, flexWrap: 'wrap' }}>
        <StatusChip tone={router.status === 'ACTIVE' ? 'good' : router.status === 'DISABLED' ? 'warn' : 'muted'}>{router.status.toLowerCase()}</StatusChip>
        <PendingBadge state={router.approval} />
        <span className="mono-sm">
          {router.kind ? KIND_LABELS[router.kind] : 'not live yet'}
          {router.activeVersion ? ` · live v${router.activeVersion.version}` : ''}
          {router.channels.length ? ` · ${router.channels.map((c) => c.name).join(', ')}` : ' · no channels'}
        </span>
      </div>
      <div className="rt-layout">
        <div>
          {draft ? (
            <RouterBuilder
              routerId={router.id}
              routerName={router.name}
              initial={draft}
              queues={choices}
              profiles={(profiles ?? []).map((p) => ({ value: p.id, label: p.name }))}
              channels={templateTargets}
              canEdit={canManage}
              problems={router.draft?.problems ?? []}
            />
          ) : (
            <p className="mono-sm">This router has no draft.</p>
          )}
        </div>
        <aside className="rt-side">
          <VersionsPanel
            routerId={router.id}
            name={router.name}
            status={router.status}
            versions={router.versions}
            activeVersionId={router.activeVersion?.id ?? null}
            activeDefinition={router.activeDefinition}
            pending={router.approval?.pending !== null && router.approval?.pending !== undefined}
            canManage={canManage}
          />
          {channels ? (
            <ChannelsPanel
              key={attached.join()}
              routerId={router.id}
              name={router.name}
              channels={channels.map((c) => ({ id: c.id, name: c.name, kind: c.kind, routerName: routerOf.get(c.id) ?? null }))}
              attached={attached}
              canManage={canManage && !router.approval?.pending}
            />
          ) : null}
          <SimulatePanel routerId={router.id} versions={router.versions.map((v) => ({ id: v.id, version: v.version }))} />
        </aside>
      </div>
    </>
  );
}
