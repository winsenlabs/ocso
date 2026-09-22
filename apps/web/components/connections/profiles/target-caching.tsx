import { DataTable } from '@/components/ui/data-table';
import { StatusChip } from '@/components/ui/status-chip';
import type { Capabilities, PromptCaching } from '@/lib/api/models';
import { cacheSettingEffect, cachingMechanism, cachingMode, targetReasonText } from '../models/meta';

export interface TargetRowView {
  key: string;
  role: 'PRIMARY' | 'FALLBACK';
  providerName: string | null;
  model: string;
  capabilities: Capabilities | null;
  /** The provider's own description of how this model caches (null: kind unavailable or settings invalid). */
  caching: PromptCaching | null;
  /** From the policy check; undefined when not validated (read-only view). */
  permitted?: boolean | undefined;
  reason?: string | null | undefined;
}

function inputs(c: Capabilities | null): string {
  if (!c) return '—';
  const on = [c.imageInput && 'image', c.fileInput && 'file', c.audioInput && 'audio'].filter(Boolean);
  return on.length ? on.join(', ') : 'text only';
}

/**
 * Per-target prompt caching (ADR-006): what each provider in the profile
 * supports — explicit breakpoints, implicit/automatic or key-based — and
 * what this profile's cache policy and TTL become for it.
 */
export function TargetCachingTable({ targets, cachePolicy, cacheTtl }: { targets: TargetRowView[]; cachePolicy: 'OFF' | 'PREFIX'; cacheTtl: '5m' | '1h' | null }) {
  const validated = targets.some((t) => t.permitted !== undefined);
  return (
    <DataTable
      label="Targets and prompt caching"
      template={validated ? 'minmax(0,1.2fr) minmax(0,1.3fr) minmax(0,1fr) 78px 104px' : 'minmax(0,1.2fr) minmax(0,1.3fr) minmax(0,1fr) 78px'}
      rows={targets}
      rowKey={(t) => t.key}
      columns={[
        {
          key: 'target',
          header: 'Target',
          cell: (t) => (
            <span>
              <b style={{ fontSize: 12 }}>{t.role === 'PRIMARY' ? 'primary' : 'fallback'}</b>
              <span className="mono-sm" style={{ display: 'block' }}>{`${t.providerName ?? 'missing provider'} · ${t.model}`}</span>
            </span>
          ),
        },
        {
          key: 'support',
          header: 'Caching support',
          cell: (t) => (
            <span>
              <StatusChip tone={cachingMode(t.caching) === 'explicit' ? 'accent' : 'muted'}>{cachingMode(t.caching)}</StatusChip>
              <span className="mono-sm" style={{ display: 'block' }}>
                {cachingMechanism(t.caching)}
              </span>
            </span>
          ),
        },
        { key: 'effect', header: 'This profile', cell: (t) => <span className="mono-sm">{cacheSettingEffect(t.caching, cachePolicy, cacheTtl)}</span> },
        { key: 'inputs', header: 'Inputs', cell: (t) => <span className="mono-sm">{inputs(t.capabilities)}</span> },
        ...(validated
          ? [
              {
                key: 'policy',
                header: 'Policy',
                cell: (t: TargetRowView) =>
                  t.permitted ? <StatusChip tone="good">permitted</StatusChip> : <StatusChip tone="warn" {...(t.reason ? { title: t.reason } : {})}>{targetReasonText(t.reason ?? null)}</StatusChip>,
              },
            ]
          : []),
      ]}
    />
  );
}
