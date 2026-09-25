import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { displayId } from '@ocso/domain';
import { hrefWith, idParam, param, type SearchParams } from '@/components/analytics/params';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { CellTitle, DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { KeyValue } from '@/components/ui/key-value';
import { PageHead } from '@/components/ui/page-head';
import { RailCard } from '@/components/ui/rail-card';
import { StatusChip, type StatusTone } from '@/components/ui/status-chip';
import { CORRECTION_STATUSES, listAgentOptions, listCorrections, type Correction, type CorrectionStatus } from '@/lib/api/quality';
import { formatDateTime } from '@/lib/format';
import { hasPermission, requireSession } from '@/lib/session';
import { CorrectionActions } from './correction-actions';
import { COMPONENT_LABELS } from './forms';
import { NewCorrection } from './new-correction';
import { RoutedDrawer } from './routed-drawer';

const TONE: Record<CorrectionStatus, StatusTone> = { OPEN: 'warn', STAGED: 'accent', APPLIED: 'good', REJECTED: 'muted' };
const SUB = 'Behaviour fixes captured from real conversations, staged into an agent’s prompt draft and shipped as a new, attributable version.';

const href = (status: string | undefined, correction?: string) => hrefWith('/corrections', { status, correction });

function columns(status: string | undefined, zone: string): Column<Correction>[] {
  return [
    {
      key: 'title',
      header: 'Correction',
      cell: (c) => (
        <CellTitle
          title={<Link href={href(status, c.id)} scroll={false}>{c.title}</Link>}
          caption={`${c.agentName} · ${COMPONENT_LABELS[c.componentKey] ?? c.componentKey} · ${c.source.toLowerCase().replace('_', ' ')}`}
        />
      ),
    },
    { key: 'seen', header: 'Observed', cell: (c) => <span className="mono">{c.occurrences}×</span> },
    {
      key: 'source',
      header: 'Source',
      cell: (c) => (c.conversationId ? <Link className="mono-sm" href={`/conversations/${c.conversationId}`}>{displayId('conv', c.conversationId)}{c.interactionSeq ? ` · turn ${c.interactionSeq}` : ''}</Link> : <span className="mono-sm">—</span>),
    },
    { key: 'status', header: 'Status', cell: (c) => <StatusChip tone={TONE[c.status]}>{c.status.toLowerCase()}</StatusChip> },
    { key: 'when', header: 'Updated', cell: (c) => <span className="mono-sm">{formatDateTime(c.updatedAt, zone)}</span> },
  ];
}

function Detail({ c, canStage, zone }: { c: Correction; canStage: boolean; zone: string }) {
  return (
    <>
      <KeyValue
        template="minmax(80px,96px) minmax(0,1fr)"
        items={[
          { k: 'agent', v: <Link href={`/agents/${c.agentId}`}>{c.agentName}</Link> },
          { k: 'component', v: COMPONENT_LABELS[c.componentKey] ?? c.componentKey },
          { k: 'observed', v: c.observed },
          { k: 'desired', v: c.desired },
          { k: 'proposed', v: c.proposedText ?? <span className="mono-sm">none yet — add it when staging</span> },
          { k: 'source', v: c.conversationId ? <Link href={`/conversations/${c.conversationId}`}>{displayId('conv', c.conversationId)}{c.interactionSeq ? ` · turn ${c.interactionSeq}` : ''}</Link> : 'recorded without a conversation' },
          { k: 'seen', v: `${c.occurrences} time${c.occurrences === 1 ? '' : 's'} · ${c.source.toLowerCase().replace('_', ' ')}` },
          { k: 'status', v: <StatusChip tone={TONE[c.status]}>{c.status.toLowerCase()}</StatusChip> },
          { k: 'recorded', v: formatDateTime(c.createdAt, zone) },
        ]}
      />
      {c.status === 'OPEN' || c.status === 'STAGED' ? <CorrectionActions id={c.id} proposedText={c.proposedText} desired={c.desired} canStage={canStage} status={c.status} /> : null}
      {c.status === 'STAGED' ? (
        <Link className="btn accent" href={`/agents/${c.agentId}?tab=prompt`}>
          Create a version from the draft
        </Link>
      ) : null}
    </>
  );
}

/** Prompt correction workflow across agents (docs/archive/specs/09 §7): record, stage into a draft, reject; versions are made on the agent's Prompt tab. */
export async function CorrectionsBody({ searchParams }: { searchParams: SearchParams }) {
  const [session, params] = await Promise.all([requireSession(), searchParams]);
  if (!hasPermission(session, Permission.CORRECTIONS_MANAGE)) {
    return (
      <>
        <PageHead title="Prompt corrections" sub={SUB} />
        <NotPermitted role={session.roleLabel} />
      </>
    );
  }
  const statusParam = param(params, 'status')?.toUpperCase();
  const status = CORRECTION_STATUSES.find((s) => s === statusParam);
  const [all, agents] = await Promise.all([listCorrections(), hasPermission(session, Permission.AGENTS_READ) ? listAgentOptions() : Promise.resolve([])]);
  const rows = status ? all.filter((c) => c.status === status) : all;
  const selected = idParam(params, 'correction');
  const open = selected ? all.find((c) => c.id === selected) : undefined;
  const source = idParam(params, 'conversation');
  const seq = Number(param(params, 'seq'));
  const zone = session.user.deployment.timezone;
  const canStage = hasPermission(session, Permission.PROMPTS_EDIT);
  const staged = new Map<string, { name: string; count: number }>();
  for (const c of all) if (c.status === 'STAGED') staged.set(c.agentId, { name: c.agentName, count: (staged.get(c.agentId)?.count ?? 0) + 1 });

  return (
    <>
      <PageHead
        title="Prompt corrections"
        sub={SUB}
        actions={
          <NewCorrection
            agents={agents.map((a) => ({ value: a.id, label: a.name }))}
            source={source ? { conversationId: source, displayId: displayId('conv', source), seq: Number.isInteger(seq) && seq > 0 ? seq : null } : null}
            openInitially={param(params, 'new') === '1' || Boolean(source)}
            closeHref={href(status?.toLowerCase())}
          />
        }
      />
      <nav className="ops-bar" aria-label="Filter by status">
        {[undefined, ...CORRECTION_STATUSES].map((s) => (
          <Link key={s ?? 'all'} href={href(s?.toLowerCase())} className={s === status ? 'fchip active' : 'fchip'} aria-current={s === status ? 'page' : undefined} scroll={false}>
            {s ? s.toLowerCase() : 'all'}
            <span className="fchip-count">{s ? all.filter((c) => c.status === s).length : all.length}</span>
          </Link>
        ))}
      </nav>
      <div className="row2">
        <DataTable
          label="Prompt corrections"
          columns={columns(status?.toLowerCase(), zone)}
          rows={rows}
          rowKey={(c) => c.id}
          selectedKey={open?.id ?? null}
          template="minmax(0,2fr) 72px minmax(0,1fr) 84px 104px"
          empty={
            <EmptyState title={status ? `No ${status.toLowerCase()} corrections` : 'No corrections yet'}>
              Record what an agent did wrong and what it should do instead — from a conversation turn or here. Staged corrections land in the agent&apos;s prompt draft; a
              Lead ships them as a new version.
            </EmptyState>
          }
        />
        <div className="rail">
          <RailCard title="Staged · waiting for a version" count={staged.size || undefined}>
            {staged.size ? (
              <div className="ops-list">
                {[...staged].map(([agentId, s]) => (
                  <div className="rowsplit" key={agentId}>
                    <span>{s.name}</span>
                    <span className="mono-sm">{s.count} staged</span>
                    <span className="sp" />
                    <Link className="btn tiny" href={`/agents/${agentId}?tab=prompt`}>
                      Create version
                    </Link>
                  </div>
                ))}
              </div>
            ) : (
              <span className="mono-sm">nothing staged — stage an open correction to put it in the agent&apos;s prompt draft</span>
            )}
          </RailCard>
        </div>
      </div>
      {open ? (
        <RoutedDrawer title={open.title} sub={`${open.agentName} · ${COMPONENT_LABELS[open.componentKey] ?? open.componentKey}`} closeHref={href(status?.toLowerCase())}>
          <Detail c={open} canStage={canStage} zone={zone} />
        </RoutedDrawer>
      ) : null}
    </>
  );
}
