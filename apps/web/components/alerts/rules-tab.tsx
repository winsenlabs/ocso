import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { SecHead } from '@/components/ui/sec-head';
import { listAlertConditions, listAlertRules, listDestinations, type AlertKind, type AlertRule, type NotificationDestination } from '@/lib/api/alerts';
import { hasPermission, type Session } from '@/lib/session';
import { SeverityChip } from './alert-chips';
import { ROLE_LABEL, alertsHref, windowLabel, type AlertsParams } from './alerts-meta';
import { RuleDialog } from './rule-dialog';
import { RuleEnabledToggle } from './rule-enabled-toggle';

const MANAGE: Record<AlertKind, Permission> = {
  TECHNICAL: Permission.ALERT_RULES_TECHNICAL_MANAGE,
  BUSINESS: Permission.ALERT_RULES_BUSINESS_MANAGE,
};

function RulesTable({ rules, destinations, canManage }: { rules: AlertRule[]; destinations: Map<string, string>; canManage: boolean }) {
  return (
    <DataTable
      label={`${rules[0]?.kind === 'TECHNICAL' ? 'Technical' : 'Business'} alert rules`}
      template="minmax(0,1.6fr) 90px 70px minmax(0,0.9fr) minmax(0,0.9fr) minmax(96px,1fr)"
      rows={rules}
      rowKey={(r) => r.id}
      columns={[
        {
          key: 'rule',
          header: 'Rule',
          cell: (r) => {
            const body = (
              <>
                <b style={{ fontSize: 12.5 }}>{r.name}</b>
                <span className="mono-sm" style={{ display: 'block' }}>
                  {r.conditionLabel ?? r.condition}
                  {r.agentId ? ' · one agent' : ''}
                </span>
              </>
            );
            return canManage ? (
              <Link className="cell-btn" href={alertsHref({ tab: 'rules', rule: r.id })} scroll={false}>
                {body}
              </Link>
            ) : (
              <span>{body}</span>
            );
          },
        },
        { key: 'sev', header: 'Severity', cell: (r) => <SeverityChip severity={r.severity} /> },
        { key: 'win', header: 'Window', cell: (r) => <span className="mono">{windowLabel(r.windowSeconds)}</span> },
        { key: 'aud', header: 'Audience', cell: (r) => <span className="mono-sm">{r.audienceRoles.map((x) => ROLE_LABEL[x] ?? x).join(', ')}</span> },
        {
          key: 'dest',
          header: 'Delivers to',
          cell: (r) => <span className="mono-sm">{r.destinationIds.length ? r.destinationIds.map((id) => destinations.get(id) ?? 'destination').join(', ') : 'in-app list only'}</span>,
        },
        {
          key: 'on',
          header: 'Enabled',
          cell: (r) => (canManage ? <RuleEnabledToggle rule={r} /> : <span className="mono-sm">{r.enabled ? 'on' : r.approval.approved ? 'off' : 'draft'}</span>),
        },
      ]}
    />
  );
}

/** Alert rules grouped by kind; each kind is editable only with its manage permission (enforced again by the API). */
export async function RulesTab({ session, params }: { session: Session; params: AlertsParams }) {
  const canTech = hasPermission(session, MANAGE.TECHNICAL);
  const canBiz = hasPermission(session, MANAGE.BUSINESS);
  const [rules, conditions, destinations] = await Promise.all([
    listAlertRules(),
    listAlertConditions(),
    canTech || canBiz || hasPermission(session, Permission.NOTIFICATION_DESTINATIONS_MANAGE) ? listDestinations() : Promise.resolve([] as NotificationDestination[]),
  ]);
  const names = new Map(destinations.map((d) => [d.id, d.name]));
  const kinds = (['TECHNICAL', 'BUSINESS'] as const).filter((k) => rules.some((r) => r.kind === k) || hasPermission(session, MANAGE[k]));
  const manageable = kinds.filter((k) => hasPermission(session, MANAGE[k]));
  const editing = params.rule && params.rule !== 'new' ? rules.find((r) => r.id === params.rule) : undefined;
  const creating = params.rule === 'new' && manageable.length > 0;

  return (
    <>
      {kinds.length === 0 ? <EmptyState title="No alert rules visible to your role">Rules for the alert kinds your role reads appear here.</EmptyState> : null}
      {kinds.map((kind) => {
        const list = rules.filter((r) => r.kind === kind);
        const canManage = hasPermission(session, MANAGE[kind]);
        return (
          <section key={kind} style={{ marginBottom: 18 }} aria-label={`${kind === 'TECHNICAL' ? 'Technical' : 'Business'} rules`}>
            <SecHead
              title={kind === 'TECHNICAL' ? 'Technical rules' : 'Business rules'}
              count={list.length}
              desc={`${kind === 'TECHNICAL' ? 'platform health · audience Tech admin' : 'agent and queue outcomes · audience Lead / Service member'} · new rules start off; turning one on needs a checker`}
              actions={
                canManage ? (
                  <Link className="btn tiny" href={alertsHref({ tab: 'rules', rule: 'new', kind })} scroll={false}>
                    New {kind === 'TECHNICAL' ? 'technical' : 'business'} rule
                  </Link>
                ) : null
              }
            />
            {list.length ? (
              <RulesTable rules={list} destinations={names} canManage={canManage} />
            ) : (
              <EmptyState title="No rules of this kind">Create one to be alerted when its condition holds.</EmptyState>
            )}
          </section>
        );
      })}
      {creating || (editing && hasPermission(session, MANAGE[editing.kind])) ? (
        <RuleDialog
          key={editing?.id ?? `new-${params.kind ?? ''}`}
          rule={editing ?? null}
          kinds={manageable}
          initialKind={editing?.kind ?? (params.kind && manageable.includes(params.kind) ? params.kind : (manageable[0] ?? 'BUSINESS'))}
          conditions={conditions}
          destinations={destinations.map((d) => ({ id: d.id, name: d.name, kind: d.kind, enabled: d.enabled }))}
          closeHref={alertsHref({ tab: 'rules' })}
        />
      ) : null}
    </>
  );
}
