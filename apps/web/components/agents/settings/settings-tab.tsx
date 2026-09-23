import { KeyValue } from '@/components/ui/key-value';
import { ChartCard } from '@/components/ui/rail-card';
import { optionName } from '../data/options';
import type { AgentPageData } from '../detail/load';
import { hoursRows, timeZoneOptions } from '../lib/business-hours';
import { CONVERSATION_TYPE_LABELS, MID_TURN_LABELS } from '../lib/labels';
import { BusinessHoursForm } from './business-hours-form';
import { OwnersCard } from './owners-card';
import { SettingsForm } from './settings-form';

/** Owning teams (ADR-026): editable by the Tech admin (any team) or a lead (their own teams), read-only otherwise. */
function Owners({ data }: { data: AgentPageData }) {
  const { agent, options, can, session } = data;
  const mode = can.assignOwner ? 'admin' : can.manage ? 'lead' : null;
  return <OwnersCard agentId={agent.id} owners={agent.teams} mode={mode} teams={options.teams ?? agent.teams} myTeamIds={session.user.teamIds} />;
}

/** Settings tab: owning teams, identity, model profiles (primary / summarizer / copilot), runtime limits and human business hours. */
export function SettingsTab({ data }: { data: AgentPageData }) {
  const { agent, options, can } = data;
  if (can.manage) {
    return (
      <div style={{ display: 'grid', gap: 18 }}>
        <Owners data={data} />
        <SettingsForm key={agent.updatedAt} agent={agent} profiles={options.profiles ?? []} />
        <BusinessHoursForm agentId={agent.id} hours={agent.businessHours} timeZones={timeZoneOptions(agent.businessHours.timezone, Intl.supportedValuesOf('timeZone'))} />
      </div>
    );
  }
  const profile = (id: string | null) => (id ? (optionName(options.profiles, id) ?? 'assigned') : 'none');
  const media = [agent.multimodal.imageInput && 'images', agent.multimodal.documentInput && 'documents', agent.multimodal.audioInput && 'audio'].filter(Boolean).join(', ');
  return (
    <div className="g g2">
      <Owners data={data} />
      <ChartCard title="Identity">
        <KeyValue
          items={[
            { k: 'name', v: agent.name },
            { k: 'slug', v: <span className="mono-sm">{agent.slug}</span> },
            { k: 'type', v: CONVERSATION_TYPE_LABELS[agent.conversationType] ?? agent.conversationType },
            { k: 'purpose', v: agent.purpose || '—' },
          ]}
        />
      </ChartCard>
      <ChartCard title="Models and runtime">
        <KeyValue
          items={[
            { k: 'conversation', v: profile(agent.modelProfileId) },
            { k: 'summarizer', v: profile(agent.summarizerProfileId) },
            { k: 'copilot', v: `${profile(agent.copilotProfileId)}${agent.copilotEnabled ? '' : ' · off'}` },
            { k: 'mid-turn', v: MID_TURN_LABELS[agent.midTurnPolicy] ?? agent.midTurnPolicy },
            { k: 'tool steps', v: `up to ${agent.maxToolSteps} per turn` },
            { k: 'media', v: `${media || 'text only'} · up to ${agent.multimodal.maxMediaPerTurn} per turn` },
          ]}
        />
      </ChartCard>
      <ChartCard title="Business hours">
        <KeyValue items={[{ k: 'AI', v: '24×7' }, ...hoursRows(agent.businessHours), { k: 'time zone', v: <span className="mono-sm">{agent.businessHours.timezone}</span> }]} />
      </ChartCard>
    </div>
  );
}
