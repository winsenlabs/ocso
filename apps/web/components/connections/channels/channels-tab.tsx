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

const CODE: Record<string, ChannelCode> = { WHATSAPP: 'WA', WEBCHAT: 'WB', CUSTOM_APP: 'AP', VOICE: 'VO', SMS: 'SM' };
const LABEL: Record<string, string> = { WHATSAPP: 'WhatsApp Business', WEBCHAT: 'Web chat', CUSTOM_APP: 'Mobile app chat', VOICE: 'Voice', SMS: 'SMS', RCS: 'RCS' };

function status(c: Channel): { tone: StatusTone; label: string } {
  if (c.status === 'ACTIVE') return { tone: 'good', label: 'live' };
  if (c.status === 'DRAFT') return { tone: 'accent', label: 'draft' };
  return { tone: 'muted', label: c.status.toLowerCase() };
}

/** Non-secret identifying settings worth showing (WhatsApp number id, web-chat JWT issuer). */
function identity(c: Channel): { k: string; v: string } | null {
  const phone = c.settings['phoneNumberId'];
  if (typeof phone === 'string') return { k: 'number id', v: phone };
  const issuer = c.settings['hostJwtIssuer'];
  if (typeof issuer === 'string') return { k: 'host jwt', v: issuer };
  return null;
}

/**
 * Channels tab (design/04): every configured channel adapter with its status,
 * inbound path, credentials (names only) and default agent. Channel setup
 * forms are not built yet: GET /v1/channels/kinds carries no field descriptors.
 */
export async function ChannelsTab({ session }: { session: Session }) {
  const [channels, kinds, agents] = await Promise.all([
    listChannels(),
    listChannelKinds(),
    hasPermission(session, Permission.AGENTS_READ) ? listAgentsLite().catch((): AgentLite[] => []) : Promise.resolve([] as AgentLite[]),
  ]);
  const agentName = (id: string | null) => (id ? (agents.find((a) => a.id === id)?.name ?? 'unknown agent') : 'none');
  return (
    <>
      <SecHead
        title="Channels"
        count={channels.length}
        desc={`adapters normalise transport into OCSO interactions · available here: ${kinds.map((k) => LABEL[k.kind] ?? k.kind).join(', ') || 'none'}`}
      />
      {channels.length === 0 ? (
        <EmptyState title="No channels configured yet">
          Configured channels appear here with their status, inbound path, credentials (by name) and default agent. The channel setup form is not
          part of this build yet.
        </EmptyState>
      ) : (
        <div className="g g3 conn-grid" role="list" aria-label="Channels">
          {channels.map((c) => {
            const id = identity(c);
            const secrets = Object.keys(c.secretRefs);
            const code = CODE[c.kind];
            return (
              <div role="listitem" key={c.id} aria-label={c.name}>
                <ProviderCard
                  logo={code ? <ChannelMark channel={code} size="lg" /> : c.kind.slice(0, 2)}
                  name={c.name}
                  status={status(c)}
                  footer={<span className="mono-sm">{c.lastInboundAt ? `last inbound ${formatAge(c.lastInboundAt)} ago` : 'nothing received yet'}</span>}
                >
                  <KeyValue
                    template="minmax(72px,88px) minmax(0,1fr)"
                    fontSize={12}
                    items={[
                      { k: 'kind', v: LABEL[c.kind] ?? c.kind },
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
    </>
  );
}
