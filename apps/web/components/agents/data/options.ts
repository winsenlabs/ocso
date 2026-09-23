import 'server-only';
import { cache } from 'react';
import { Permission } from '@ocso/auth';
import { listChannels, type Channel } from '@/lib/api/channels';
import { listProfiles } from '@/lib/api/models';
import { listQueues, optional } from '@/lib/api/agents';
import { listTeams } from '@/lib/api/teams';
import type { Session } from '@/lib/session';
import type { Queue } from './agent-schemas';

/** Choices for agent forms: model profiles, queues and channels the user may read. */
export interface Option {
  id: string;
  name: string;
  caption?: string;
}

export interface AgentOptions {
  /** null: the role cannot list them (the field is shown read-only or hidden). */
  profiles: Option[] | null;
  queues: Option[] | null;
  channels: Option[] | null;
  /** Every team (owning-team pickers, ADR-026); null when the directory cannot be read. */
  teams: Option[] | null;
  queueRows: Queue[] | null;
  channelRows: Channel[] | null;
}

/** Once per request (the page head and body both need it). */
export const loadAgentOptions = cache(async (session: Session): Promise<AgentOptions> => {
  const can = (p: Permission) => session.permissions.has(p);
  const [profiles, queues, channels, teams] = await Promise.all([
    optional(listProfiles()),
    can(Permission.QUEUES_READ) ? optional(listQueues()) : Promise.resolve(null),
    can(Permission.CHANNELS_READ) ? optional(listChannels()) : Promise.resolve(null),
    optional(listTeams()),
  ]);
  return {
    profiles: profiles?.map((p) => ({ id: p.id, name: p.name, caption: `${p.providerName ?? p.providerKind ?? 'provider'} · ${p.model}` })) ?? null,
    queues: queues?.map((q) => ({ id: q.id, name: q.name, caption: `${q.members} people · ${q.mode === 'AUTO_ASSIGN' ? 'auto-assign' : 'open pickup'}` })) ?? null,
    channels: channels?.map((c) => ({ id: c.id, name: c.name, caption: `${c.kind.toLowerCase()} · ${c.status.toLowerCase()}` })) ?? null,
    teams: teams?.map((t) => ({ id: t.id, name: t.name, caption: `${t.memberCount} people` })) ?? null,
    queueRows: queues,
    channelRows: channels,
  };
});

export const optionName = (options: Option[] | null, id: string | null): string | null => (id ? (options?.find((o) => o.id === id)?.name ?? null) : null);
