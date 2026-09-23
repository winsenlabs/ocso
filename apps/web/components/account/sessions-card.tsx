import { SecHead } from '@/components/ui/sec-head';
import { StatusChip } from '@/components/ui/status-chip';
import type { SessionRow } from '@/lib/api/account';
import { formatDateTime } from '@/lib/format';
import { RowAction } from './row-action';

const METHOD: Record<string, string> = { password: 'password', mfa: 'password + code', passkey: 'passkey', sso: 'single sign-on' };

/** Where this account is signed in; any session but this one can be signed out. */
export function SessionsCard({ sessions, currentId, timeZone }: { sessions: SessionRow[]; currentId: string | null; timeZone: string }) {
  const others = sessions.filter((s) => s.id !== currentId).length;
  return (
    <section className="ch sec-card" aria-label="Active sessions">
      <SecHead title="Active sessions" count={sessions.length} actions={others ? <RowAction kind="others" id="" label="Sign out other sessions" /> : null} />
      <div>
        {sessions.map((s) => (
          <div className="sec-row" key={s.id}>
            <div className="sec-main">
              <b>
                {describeAgent(s.userAgent)} {s.id === currentId ? <StatusChip tone="good">this session</StatusChip> : null}
              </b>
              <span className="mono-sm">
                {METHOD[s.authMethod ?? ''] ?? 'password'} · {s.ipAddress || 'address unknown'} · signed in {formatDateTime(s.createdAt.toISOString(), timeZone)} · ends {formatDateTime(s.expiresAt.toISOString(), timeZone)}
              </span>
            </div>
            {s.id === currentId ? null : <RowAction kind="session" id={s.id} label="Sign out" ariaLabel={`Sign out ${describeAgent(s.userAgent)} session`} />}
          </div>
        ))}
      </div>
    </section>
  );
}

function describeAgent(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /node|undici/i.test(ua) ? 'API client' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}
