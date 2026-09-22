import type { DeploymentFact, EcsDeploymentStatus } from '../contract.js';

/** The ECS status as deployment-panel rows (service, tasks, rollout, scalable target, policies, alarms). */
export function ecsFacts(d: Omit<EcsDeploymentStatus, 'facts'>): DeploymentFact[] {
  const count = (v: number | null) => (v === null ? '—' : String(v));
  const target = d.scalableTarget;
  return [
    { label: 'service', value: `${d.cluster} / ${d.service} · ${d.serviceStatus.toLowerCase()}` },
    { label: 'tasks', value: `desired ${count(d.desiredCount)} · running ${count(d.runningCount)} · pending ${count(d.pendingCount)}` },
    { label: 'rollout', value: d.rolloutState?.toLowerCase() ?? '—' },
    {
      label: 'scalable target',
      value: target ? `${target.minCapacity} – ${target.maxCapacity}${target.dynamicScalingSuspended ? ' · dynamic scaling suspended' : ''}` : 'not registered',
    },
    {
      label: 'policies',
      value: d.policies.length ? d.policies.map((p) => `${p.name}${p.present ? '' : ' · missing'}`).join(', ') : 'none',
      states: d.policies.map((p) => ({ name: `${p.name}${p.present ? '' : ' · missing'}`, tone: p.present ? 'good' : 'danger', title: p.type })),
    },
    {
      label: 'alarms',
      value: d.alarms.length ? d.alarms.map((a) => `${a.name} · ${a.state.toLowerCase()}`).join(', ') : 'none',
      states: d.alarms.map((a) => ({
        name: `${a.name} · ${a.state.toLowerCase().replace(/_/g, ' ')}`,
        tone: a.state === 'OK' ? 'good' : a.state === 'ALARM' ? 'danger' : 'muted',
      })),
    },
  ];
}
