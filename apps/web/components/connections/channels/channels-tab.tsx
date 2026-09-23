import { headers } from 'next/headers';
import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { ChannelMark } from '@/components/ui/channel-mark';
import { EmptyState } from '@/components/ui/empty-state';
import { KeyValue } from '@/components/ui/key-value';
import { ProviderCard } from '@/components/ui/provider-card';
import { SecHead } from '@/components/ui/sec-head';
import type { StatusTone } from '@/components/ui/status-chip';
import { listChannelKinds, listChannels, type Channel } from '@/lib/api/channels';
import { listAgentsLite, type AgentLite } from '@/lib/api/mcp';
import { formatAge } from '@/lib/format';
import { hasPermission, type Session } from '@/lib/session';
import { connectionsHref, idParam, param } from '../url';
import { LifecycleActions } from '../lifecycle-actions';
import { ChannelDialog } from './channel-dialog';
import { identitySettingOf } from './settings-form';


function status(c: Channel): { tone: StatusTone; label: string } {
  if (c.status === 'ACTIVE') return { tone: 'good', label: 'live' };
  if (c.status === 'DRAFT') return { tone: 'accent', label: 'draft' };
  return { tone: 'muted', label: c.status.toLowerCase() };
}



/** The origin customers and providers reach (OCSO_PUBLIC_URL, else this request's host — ADR-020 one public origin). */
async function publicOrigin(): Promise<string> {
  const configured = process.env['OCSO_PUBLIC_URL'];
  if (configured && URL.canParse(configured)) return new URL(configured).origin;
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}

type Params = Record<string, string | string[] | undefined>;

/**
 * Channels tab (design/04): every configured channel with its status, inbound
 * path, credentials (names only) and default agent, plus Add / Edit channel
 * built from the adapters' descriptors (GET /v1/channels/kinds).
 */
export async function ChannelsTab({ session, params }: { session: Session; params: Params }) {
  const canManage = hasPermission(session, Permission.CHANNELS_MANAGE);
  const canTemplates = hasPermission(session, Permission.MESSAGE_TEMPLATES_MANAGE);
  const [channels, kinds, agents, origin] = await Promise.all([
    listChannels(),
    listChannelKinds(),
    hasPermission(session, Permission.AGENTS_READ) ? listAgentsLite().catch((): AgentLite[] => []) : Promise.resolve([] as AgentLite[]),
    publicOrigin(),
  ]);
  const dialog = canManage ? param(params, 'dialog') : undefined;
  const editing = dialog === 'channel-edit' ? channels.find((c) => c.id === idParam(params, 'id')) : undefined;
  const kindOf = (kind: string) => kinds.find((k) => k.kind === kind);
  const kindLabel = (kind: string) => kindOf(kind)?.label ?? kind;
  const agentName = (id: string | null) => (id ? (agents.find((a) => a.id === id)?.name ?? 'unknown agent') : 'none');
  return (
    <>
      <SecHead
        title="Channels"
        count={channels.length}
        desc={`adapters normalise transport into OCSO interactions · available here: ${kinds.map((k) => kindLabel(k.kind)).join(', ') || 'none'}`}
        actions={
          canManage && kinds.length ? (
            <Link className="btn tiny" href={connectionsHref({ tab: 'channels', dialog: 'channel-new' })} scroll={false}>
              Add channel
            </Link>
          ) : null
        }
      />
      {channels.length === 0 ? (
        <EmptyState title="No channels configured yet">
          {canManage
            ? `Add a channel: ${kinds.map((k) => k.label ?? k.kind).join(', ') || 'no channel kinds are installed'}. Each asks for exactly what its provider needs.`
            : 'A Tech admin adds channels; each appears here with its status, inbound path, credentials (by name) and default agent.'}
        </EmptyState>
      ) : (
        <div className="g g3 conn-grid" role="list" aria-label="Channels">
          {channels.map((c) => {
            const kind = kindOf(c.kind);
            const id = identitySettingOf(c.settings, kind?.identitySetting ?? null);
            const secrets = Object.keys(c.secretRefs).sort();
            return (
              <div role="listitem" key={c.id} aria-label={c.name}>
                <ProviderCard
                  logo={kind?.mark ? <ChannelMark mark={kind.mark} size="lg" /> : c.kind.slice(0, 2)}
                  name={c.name}
                  status={status(c)}
                  footer={
                    <div className="rowsplit">
                      {canManage ? (
                        <Link className="btn tiny ghost" href={connectionsHref({ tab: 'channels', dialog: 'channel-edit', id: c.id })} scroll={false} aria-label={`Edit ${c.name}`}>
                          Edit
                        </Link>
                      ) : null}
                      {canTemplates && kind?.messageTemplates ? (
                        <Link className="btn tiny ghost" href={`/templates?channel=${encodeURIComponent(c.id)}`} aria-label={`Message templates of ${c.name}`}>
                          Templates
                        </Link>
                      ) : null}
                      {canManage ? (
                        <LifecycleActions kind="channel" id={c.id} name={c.name} state={c.status === 'ACTIVE' ? 'live' : c.status === 'DISABLED' ? 'stopped' : 'draft'} approval={c.approval} />
                      ) : null}
                      <span className="sp" />
                      <span className="mono-sm">{c.lastInboundAt ? `last inbound ${formatAge(c.lastInboundAt)} ago` : 'nothing received yet'}</span>
                    </div>
                  }
                >
                  <KeyValue
                    template="minmax(72px,88px) minmax(0,1fr)"
                    fontSize={12}
                    items={[
                      { k: 'kind', v: kindLabel(c.kind) },
                      ...(id ? [id] : []),
                      { k: c.embedPath && !c.webhookPath ? 'widget' : 'inbound', v: <span className="mono-sm">{c.webhookPath ?? c.embedPath ?? '—'}</span> },
                      { k: 'credentials', v: secrets.length ? `${secrets.join(', ')} set` : 'none set' },
                      {
                        // channel → router → queue → agent (PM/research/11 §5.7): the channel shows its router.
                        k: 'router',
                        v: c.router ? (
                          <Link href={`/routers/${encodeURIComponent(c.router.id)}`}>
                            {c.router.name}
                            {c.router.status === 'ACTIVE' ? '' : ` (${c.router.status.toLowerCase()})`}
                            {c.defaultAgentId ? ` · ${agentName(c.defaultAgentId)}` : ''}
                          </Link>
                        ) : (
                          <span className="warn-text">none: new customer messages are rejected until a router is attached (Routers)</span>
                        ),
                      },
                    ]}
                  />
                </ProviderCard>
              </div>
            );
          })}
        </div>
      )}
      {dialog === 'channel-new' || editing ? (
        <ChannelDialog
          key={editing?.id ?? `new-${param(params, 'kind') ?? ''}`}
          kinds={kinds}
          channel={editing ?? null}
          initialKind={kinds.find((k) => k.kind === param(params, 'kind'))?.kind ?? null}
          agents={agents}
          publicOrigin={origin}
          closeHref={connectionsHref({ tab: 'channels' })}
        />
      ) : null}
    </>
  );
}
