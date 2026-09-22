import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { SecHead } from '@/components/ui/sec-head';
import { StatusChip, type StatusTone } from '@/components/ui/status-chip';
import { listChannels, type Channel } from '@/lib/api/channels';
import { getDeploymentSettings } from '@/lib/api/settings';
import { listDeliveries, listWebhookEventTypes, listWebhooks, type Delivery, type Webhook } from '@/lib/api/webhooks';
import { formatAge, formatNumber } from '@/lib/format';
import { hasPermission, type Session } from '@/lib/session';
import { connectionsHref, idParam, param } from '../url';
import { DeliveryList } from './delivery-list';
import { WebhookDialog } from './webhook-dialog';

type Params = Record<string, string | string[] | undefined>;

interface Row {
  key: string;
  endpoint: string;
  caption: string;
  href: string | null;
  events: string;
  direction: 'inbound' | 'outbound';
  volume: string;
  failures: string;
  state: { tone: StatusTone; label: string };
}

function outbound(h: Webhook): Row {
  const total = h.last24h.sent + h.last24h.failed + h.last24h.pending;
  const state: Row['state'] = !h.enabled
    ? { tone: 'muted', label: 'disabled' }
    : h.last24h.failed
      ? { tone: 'danger', label: 'failing' }
      : h.last24h.pending
        ? { tone: 'warn', label: 'retrying' }
        : { tone: 'good', label: 'ok' };
  return {
    key: h.id,
    endpoint: h.url.replace(/^https:\/\//, ''),
    caption: `${h.name}${h.lastDeliveryAt ? ` · last delivery ${formatAge(h.lastDeliveryAt)} ago` : ' · no deliveries yet'}`,
    href: connectionsHref({ tab: 'webhooks', dialog: 'webhook-edit', id: h.id }),
    events: h.events.join(', '),
    direction: 'outbound',
    volume: formatNumber(total),
    failures: formatNumber(h.last24h.failed),
    state,
  };
}

/** Inbound channel callbacks, derived from the channels' webhook paths (no delivery counters exist for them). */
function inbound(c: Channel): Row | null {
  if (!c.webhookPath) return null;
  const live = c.status === 'ACTIVE';
  return {
    key: c.id,
    endpoint: c.webhookPath,
    caption: `${c.name}${c.lastInboundAt ? ` · last inbound ${formatAge(c.lastInboundAt)} ago` : ' · nothing received yet'}`,
    href: null,
    events: c.kind === 'WHATSAPP' ? 'messages, delivery statuses' : 'customer messages',
    direction: 'inbound',
    volume: '—',
    failures: '—',
    state: live ? { tone: 'good', label: 'live' } : { tone: 'muted', label: c.status.toLowerCase() },
  };
}

/** Webhooks tab (design/04): outbound event subscriptions plus the inbound channel callbacks. */
export async function WebhooksTab({ session, params }: { session: Session; params: Params }) {
  const canChannels = hasPermission(session, Permission.CHANNELS_READ);
  const id = idParam(params, 'id');
  const dialog = param(params, 'dialog');
  const status = (['PENDING', 'SENT', 'FAILED'] as const).find((s) => s === param(params, 'deliveries'));
  const [hooks, eventTypes, channels, settings] = await Promise.all([
    listWebhooks(),
    listWebhookEventTypes(),
    canChannels ? listChannels() : Promise.resolve([] as Channel[]),
    getDeploymentSettings(),
  ]);
  const editing = dialog === 'webhook-edit' && id ? hooks.find((h) => h.id === id) : undefined;
  const deliveries: Delivery[] = editing ? await listDeliveries(editing.id, status) : [];
  const rows = [...hooks.map(outbound), ...channels.map(inbound).filter((r): r is Row => r !== null)];
  const closeHref = connectionsHref({ tab: 'webhooks' });

  return (
    <>
      <SecHead
        title="Webhooks"
        count={rows.length}
        desc="inbound channel callbacks and outbound event delivery"
        actions={
          <Link className="btn tiny" href={connectionsHref({ tab: 'webhooks', dialog: 'webhook-new' })} scroll={false}>
            Add endpoint
          </Link>
        }
      />
      <DataTable
        label="Webhooks"
        template="minmax(0,1.2fr) minmax(0,1fr) 88px 84px 84px 90px"
        rows={rows}
        rowKey={(r) => r.key}
        empty={<EmptyState title="No webhook endpoints yet">Add an outbound endpoint to receive signed OCSO events; channel callbacks appear once a channel exists.</EmptyState>}
        columns={[
          {
            key: 'endpoint',
            header: 'Endpoint',
            cell: (r) => {
              const body = (
                <>
                  <span className="mono-sm" style={{ color: 'var(--ink)' }}>
                    {r.endpoint}
                  </span>
                  <span className="mono-sm" style={{ display: 'block' }}>
                    {r.caption}
                  </span>
                </>
              );
              return r.href ? (
                <Link className="cell-link" href={r.href} scroll={false}>
                  {body}
                </Link>
              ) : (
                <span>{body}</span>
              );
            },
          },
          { key: 'events', header: 'Events', cell: (r) => <span className="mono-sm">{r.events}</span> },
          { key: 'dir', header: 'Direction', cell: (r) => <span className="mono-sm">{r.direction}</span> },
          { key: 'vol', header: '24h', cell: (r) => <span className="mono">{r.volume}</span> },
          { key: 'fail', header: 'Failures', cell: (r) => <span className="mono">{r.failures}</span> },
          { key: 'state', header: 'State', cell: (r) => <StatusChip tone={r.state.tone}>{r.state.label}</StatusChip> },
        ]}
      />
      <p className="mono-sm" style={{ marginTop: 10 }}>
        Receivers verify <span className="mono">X-OCSO-Signature: t=&lt;unix&gt;,v1=&lt;hex HMAC-SHA256(secret, &quot;&lt;t&gt;.&lt;body&gt;&quot;)&gt;</span>; reject old
        timestamps and dedupe on <span className="mono">X-OCSO-Delivery</span>. Payloads carry identifiers and metadata only, never message content.
      </p>
      {dialog === 'webhook-new' || editing ? (
        <WebhookDialog key={editing?.id ?? 'new'} webhook={editing ?? null} eventTypes={eventTypes} closeHref={closeHref}>
          {editing ? <DeliveryList webhookId={editing.id} deliveries={deliveries} status={status} timezone={settings.timezone} /> : null}
        </WebhookDialog>
      ) : null}
    </>
  );
}
