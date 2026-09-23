import { PERMISSION_GROUPS } from '@ocso/auth';
import { StatusChip } from '@/components/ui/status-chip';
import type { EffectivePermission, UserPermissions } from '@/lib/api/permissions';

/** "3 Oct 2026" in the deployment's timezone. */
export function formatDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone }).format(new Date(iso));
}

function SourceChips({ row, timeZone }: { row: EffectivePermission; timeZone: string }) {
  return (
    <span className="tm-chips">
      {row.sources.map((s) =>
        s.kind === 'PRESET' ? (
          <StatusChip key="preset" tone="muted" title="Part of the user's preset">
            preset
          </StatusChip>
        ) : (
          <StatusChip
            key={s.overrideId}
            tone="accent"
            title={`Granted${s.grantedBy ? ` by ${s.grantedBy.name}` : ''}: ${s.reason}${s.proposalId ? ' · approved' : ''}`}
          >
            {s.expiresAt ? `granted until ${formatDay(s.expiresAt, timeZone)}` : 'granted'}
          </StatusChip>
        ),
      )}
      {row.revoked ? (
        <StatusChip tone="danger" title={`Revoked${row.revoked.revokedBy ? ` by ${row.revoked.revokedBy.name}` : ''}: ${row.revoked.reason}`}>
          revoked
        </StatusChip>
      ) : null}
    </span>
  );
}

/**
 * A user's effective permissions grouped as the catalogue groups them, each
 * with where it comes from: the preset, a grant (and until when), or a revoke
 * that removes a preset permission (PM/research/11 §3.6).
 */
export function PermissionsPanel({ view, timeZone }: { view: UserPermissions; timeZone: string }) {
  const active = view.effective.filter((e) => e.active).length;
  const expired = view.overrides.filter((o) => o.expired);
  return (
    <section className="tm-sec" aria-label="Effective permissions">
      <p className="mono-sm">
        {active} permissions · preset {view.presetLabel}
        {view.overrides.length ? ` · ${view.overrides.length - expired.length} per-user change${view.overrides.length - expired.length === 1 ? '' : 's'}` : ''}
        {view.status !== 'ACTIVE' ? ' · none apply until the user is active' : ''}
      </p>
      {PERMISSION_GROUPS.map((group) => {
        const rows = view.effective.filter((e) => e.group === group);
        if (!rows.length) return null;
        return (
          <div key={group} className="tm-perm-group">
            <h3 className="grp">{group.toLowerCase()}</h3>
            <ul className="tm-perms" aria-label={group}>
              {rows.map((row) => (
                <li key={row.permission} className={row.active ? undefined : 'off'}>
                  <span className="tm-perm-name">
                    <b>{row.label}</b>
                    <span className="mono-sm">{row.permission}</span>
                  </span>
                  <SourceChips row={row} timeZone={timeZone} />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {expired.length ? (
        <p className="mono-sm">
          Expired grants (no longer effective): {expired.map((o) => `${o.label} (${o.expiresAt ? formatDay(o.expiresAt, timeZone) : ''})`).join(', ')}
        </p>
      ) : null}
    </section>
  );
}
