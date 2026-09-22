import { headers } from 'next/headers';
import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { ChannelMark, type ChannelCode } from '@/components/ui/channel-mark';
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
import { ChannelDialog } from './channel-dialog';

const CODE: Record<string, ChannelCode> = { TWILIO_WHATSAPP: 'WA', WHATSAPP: 'WA', WEBCHAT: 'WB', CUSTOM_APP: 'AP', VOICE: 'VO', SMS: 'SM' };
const LABEL: Record<string, string> = {
  TWILIO_WHATSAPP: 'WhatsApp — Twilio',
  WHATSAPP: 'WhatsApp — Meta Cloud API',
  WEBCHAT: 'Web chat',
  CUSTOM_APP: 'Mobile app chat',
  VOICE: 'Voice',
  SMS: 'SMS',
  RCS: 'RCS',
};

function status(c: Channel): { tone: StatusTone; label: string } {
  if (c.status === 'ACTIVE') return { tone: 'good', label: 'live' };
  if (c.status === 'DRAFT') return { tone: 'accent', label: 'draft' };
  return { tone: 'muted', label: c.status.toLowerCase() };
}

/** Non-secret identifying settings worth showing (Twilio sender, WhatsApp number id, web-chat JWT issuer). */
function identity(c: Channel): { k: string; v: string } | null {
  const sender = c.settings['from'] ?? c.settings['messagingServiceSid'];
  if (c.kind === 'TWILIO_WHATSAPP' && typeof sender === 'string') return { k: 'sender', v: sender };
  const phone = c.settings['phoneNumberId'];
  if (typeof phone === 'string') return { k: 'number id', v: phone };
  const issuer = c.settings['hostJwtIssuer'];
  if (typeof issuer === 'string') return { k: 'host jwt', v: issuer };
  return null;
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
  const [channels, kinds, agents, origin] = await Promise.all([
    listChannels(),
    listChannelKinds(),
    hasPermission(session, Permission.AGENTS_READ) ? listAgentsLite().catch((): AgentLite[] => []) : Promise.resolve([] as AgentLite[]),
    publicOrigin(),
  ]);
  const dialog = canManage ? param(params, 'dialog') : undefined;
  const editing = dialog === 'channel-edit' ? channels.find((c) => c.id === idParam(params, 'id')) : undefined;
  const kindLabel = (kind: string) => kinds.find((k) => k.kind === kind)?.label ?? LABEL[kind] ?? kind;
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
            ? 'Add a channel: WhatsApp through Twilio needs your Account SID, auth token and WhatsApp sender (or Meta’s number id and tokens for the Cloud API); web chat needs only the sites allowed to embed it.'
            : 'A Platform Tech Admin adds channels; each appears here with its status, inbound path, credentials (by name) and default agent.'}
        </EmptyState>
      ) : (
        <div className="g g3 conn-grid" role="list" aria-label="Channels">
          {channels.map((c) => {
            const id = identity(c);
            const secrets = Object.keys(c.secretRefs).sort();
            const code = CODE[c.kind];
            return (
              <div role="listitem" key={c.id} aria-label={c.name}>
                <ProviderCard
                  logo={code ? <ChannelMark channel={code} size="lg" /> : c.kind.slice(0, 2)}
                  name={c.name}
                  status={status(c)}
                  footer={
                    <div className="rowsplit">
                      {canManage ? (
                        <Link className="btn tiny ghost" href={connectionsHref({ tab: 'channels', dialog: 'channel-edit', id: c.id })} scroll={false} aria-label={`Edit ${c.name}`}>
                          Edit
                        </Link>
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
                      { k: 'inbound', v: <span className="mono-sm">{c.webhookPath ?? '—'}</span> },
                      { k: 'credentials', v: secrets.length ? `${secrets.join(', ')} set` : 'none set' },
                      { k: 'agent', v: agentName(c.defaultAgentId) },
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
