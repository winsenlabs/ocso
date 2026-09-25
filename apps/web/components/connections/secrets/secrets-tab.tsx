import { Permission } from '@ocso/auth';
import { AlertBanner } from '@/components/ui/alert-banner';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { SecHead } from '@/components/ui/sec-head';
import { StatusChip } from '@/components/ui/status-chip';
import { listSecrets, listSigningKeys, type SigningKey } from '@/lib/api/secrets';
import { getDeploymentSettings } from '@/lib/api/settings';
import { formatDateTime } from '@/lib/format';
import { hasPermission, type Session } from '@/lib/session';
import { RotateSigningKey } from './rotate-signing-key';

const STATE = { ok: { tone: 'good', label: 'ok' }, expiring: { tone: 'warn', label: 'expiring' }, expired: { tone: 'danger', label: 'expired' } } as const;
const KEY_TONE: Record<string, 'good' | 'warn' | 'muted'> = { ACTIVE: 'good', RETIRING: 'warn', RETIRED: 'muted' };

/** Secrets & credentials (design/04): secret-store metadata only, plus the customer-claims signing keys. */
export async function SecretsTab({ session }: { session: Session }) {
  const canKeys = hasPermission(session, Permission.SYSTEM_CONFIGURE);
  const [secrets, keys, settings] = await Promise.all([listSecrets(), canKeys ? listSigningKeys() : Promise.resolve(null), getDeploymentSettings()]);
  const tz = settings.timezone;
  const date = (iso: string | null) => (iso ? formatDateTime(iso, tz) : '—');
  return (
    <>
      <AlertBanner title="PostgreSQL stores references only.">
        Values live in the configured secret store and are resolved inside trusted execution code. They are never placed in prompts, telemetry or
        tool arguments, and no API returns them.
      </AlertBanner>
      <SecHead title="Stored credentials" count={secrets.length} desc="created by the forms that need them — provider, MCP, channel and webhook credentials" />
      <DataTable
        label="Secrets"
        template="minmax(0,1fr) 120px minmax(0,1fr) 110px 110px 84px"
        rows={secrets}
        rowKey={(s) => s.ref}
        empty={<EmptyState title="No secrets stored yet">Credentials appear here, by reference, once a provider, MCP connection, channel or webhook stores one.</EmptyState>}
        columns={[
          {
            key: 'ref',
            header: 'Reference',
            cell: (s) => (
              <span>
                <span className="mono" style={{ fontSize: 12 }}>
                  {s.ref}
                </span>
                <span className="mono-sm" style={{ display: 'block' }}>
                  {s.name}
                </span>
              </span>
            ),
          },
          { key: 'kind', header: 'Type', cell: (s) => <span className="mono-sm">{s.kind.toLowerCase().replace(/_/g, ' ')}</span> },
          { key: 'used', header: 'Used by', cell: (s) => <span className="mono-sm">{s.usedBy ?? '—'}</span> },
          { key: 'rot', header: 'Rotated', cell: (s) => <span className="mono-sm">{s.rotatedAt ? `${date(s.rotatedAt)} · v${s.version}` : `never · v${s.version}`}</span> },
          { key: 'exp', header: 'Expires', cell: (s) => <span className="mono-sm">{date(s.expiresAt)}</span> },
          { key: 'state', header: 'State', cell: (s) => <StatusChip tone={STATE[s.state].tone}>{STATE[s.state].label}</StatusChip> },
        ]}
      />
      {keys ? <SigningKeys keys={keys} date={date} /> : null}
    </>
  );
}

function SigningKeys({ keys, date }: { keys: SigningKey[]; date: (iso: string | null) => string }) {
  return (
    <section aria-labelledby="keys-h" style={{ marginTop: 18 }}>
      <SecHead id="keys-h" title="Customer-claims signing keys" count={keys.length} desc="ES256 · public keys at /.well-known/jwks.json" actions={<RotateSigningKey />} />
      <DataTable
        label="Signing keys"
        template="minmax(0,1.4fr) 100px 140px 140px"
        rows={keys}
        rowKey={(k) => k.kid}
        empty={<EmptyState title="No signing key yet">A key is created the first time OCSO signs customer claims for a tool server, or when you rotate.</EmptyState>}
        columns={[
          { key: 'kid', header: 'Key id', cell: (k) => <span className="mono-sm">{k.kid}</span> },
          { key: 'status', header: 'Status', cell: (k) => <StatusChip tone={KEY_TONE[k.status] ?? 'muted'}>{k.status.toLowerCase()}</StatusChip> },
          { key: 'created', header: 'Created', cell: (k) => <span className="mono-sm">{date(k.createdAt)}</span> },
          { key: 'retiring', header: 'Retiring since', cell: (k) => <span className="mono-sm">{date(k.retiringAt)}</span> },
        ]}
      />
    </section>
  );
}
