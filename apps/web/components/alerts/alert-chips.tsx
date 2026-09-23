import { StatusChip } from '@/components/ui/status-chip';
import { SEVERITY_TONE, STATE_CHIP } from './alerts-meta';

export function SeverityChip({ severity }: { severity: string }) {
  return <StatusChip tone={SEVERITY_TONE[severity] ?? 'muted'}>{severity.toLowerCase()}</StatusChip>;
}

export function StateChip({ status }: { status: string }) {
  const chip = STATE_CHIP[status] ?? { tone: 'muted' as const, label: status.toLowerCase() };
  return <StatusChip tone={chip.tone}>{chip.label}</StatusChip>;
}

export function KindChip({ kind }: { kind: string }) {
  return <StatusChip tone={kind === 'TECHNICAL' ? 'accent' : 'muted'}>{kind === 'TECHNICAL' ? 'technical' : 'business'}</StatusChip>;
}
