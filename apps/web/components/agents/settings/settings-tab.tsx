import { KeyValue } from '@/components/ui/key-value';
import { ChartCard } from '@/components/ui/rail-card';
import { optionName } from '../data/options';
import type { AgentPageData } from '../detail/load';
import { CONVERSATION_TYPE_LABELS, MID_TURN_LABELS } from '../lib/labels';
import { SettingsForm } from './settings-form';

/** Settings tab: identity, model profiles (primary / summarizer / copilot) and runtime limits. */
export function SettingsTab({ data }: { data: AgentPageData }) {
  const { agent, options, can } = data;
  if (can.manage) return <SettingsForm key={agent.updatedAt} agent={agent} profiles={options.profiles ?? []} />;
  const profile = (id: string | null) => (id ? (optionName(options.profiles, id) ?? 'assigned') : 'none');
  const media = [agent.multimodal.imageInput && 'images', agent.multimodal.documentInput && 'documents', agent.multimodal.audioInput && 'audio'].filter(Boolean).join(', ');
  return (
    <div className="g g2">
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
    </div>
  );
}
