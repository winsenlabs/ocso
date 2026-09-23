import { Avatar, type AvatarTone } from '@/components/ui/avatar';
import { ChannelMark, type ChannelCode } from '@/components/ui/channel-mark';
import { CONTROL_STATE_LABELS, ControlState, type ControlStateKind } from '@/components/ui/control-state';
import { FilterChips } from '@/components/ui/filter-chips';
import { Kbd } from '@/components/ui/kbd';
import { Presence, type PresenceState } from '@/components/ui/presence';
import { RiskBadge } from '@/components/ui/risk-badge';
import { SlaTimer } from '@/components/ui/sla-timer';
import { StatusChip, type StatusTone } from '@/components/ui/status-chip';
import { Caption, PreviewSection, Row } from './preview-section';

const TONES: Array<[StatusTone, string]> = [
  ['good', 'healthy'],
  ['warn', 'degraded'],
  ['danger', 'failing'],
  ['accent', 'draft'],
  ['muted', 'standby'],
];
const CONTROL: ControlStateKind[] = ['ai', 'wait', 'human', 'returning', 'resolved', 'routing'];
const CHANNELS: ChannelCode[] = ['WA', 'WB', 'AP', 'EM', 'VO', 'IG', 'SM'];
const PRESENCE: PresenceState[] = ['working', 'waiting', 'blocked', 'onboarding', 'idle', 'off_shift', 'paused', 'error'];
const AVATARS: AvatarTone[] = ['indigo', 'violet', 'rose', 'amber', 'emerald', 'sky', 'teal', 'walle'];

/** Chips, marks and small status primitives in every state. */
export function ChipsPreview() {
  return (
    <PreviewSection title="Status primitives">
      <Row>
        <Caption>StatusChip</Caption>
        {TONES.map(([tone, label]) => (
          <StatusChip key={tone} tone={tone}>
            {label}
          </StatusChip>
        ))}
      </Row>
      <Row>
        <Caption>ControlState</Caption>
        {CONTROL.map((s) => (
          <ControlState key={s} state={s}>
            {CONTROL_STATE_LABELS[s]}
          </ControlState>
        ))}
      </Row>
      <Row>
        <Caption>RiskBadge</Caption>
        <RiskBadge risk="read" />
        <RiskBadge risk="write" />
        <RiskBadge risk="2-step" />
        <Caption>ChannelMark</Caption>
        {CHANNELS.map((c) => (
          <ChannelMark key={c} channel={c} />
        ))}
        <ChannelMark channel="WA" size="lg" />
      </Row>
      <Row>
        <Caption>SlaTimer</Caption>
        <SlaTimer level="ok" progress={0.3} label="10:40" />
        <SlaTimer level="risk" progress={0.78} label="04:12 to SLA" />
        <SlaTimer level="breach" progress={1} label="breached 01:38" />
        <SlaTimer level="ok" label="held 06:20" bar={false} />
      </Row>
      <Row>
        <Caption>Presence</Caption>
        {PRESENCE.map((p) => (
          <Presence key={p} state={p}>
            {p.replace('_', ' ')}
          </Presence>
        ))}
      </Row>
      <Row>
        <Caption>Avatar</Caption>
        {AVATARS.map((t) => (
          <Avatar key={t} initials={t.slice(0, 2).toUpperCase()} tone={t} />
        ))}
        <Avatar initials="SM" size="sm" />
        <Avatar initials="LG" size="lg" tone="sky" />
        <Caption>Kbd</Caption>
        <Kbd>⌘K</Kbd>
        <Kbd>⌘J</Kbd>
      </Row>
      <Row>
        <Caption>FilterChips</Caption>
        <FilterChips
          label="Conversation filter"
          defaultValue="mine"
          options={[
            { key: 'all', label: 'All', count: 312 },
            { key: 'mine', label: 'Assigned to me', count: 7 },
            { key: 'waiting', label: 'Waiting for human', count: 4 },
            { key: 'resolved', label: 'Resolved' },
          ]}
        />
      </Row>
    </PreviewSection>
  );
}
