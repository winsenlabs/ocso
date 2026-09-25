'use client';

import { useState, useTransition } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { StatusChip } from '@/components/ui/status-chip';
import { testChannelAction } from '@/lib/actions/channels';
import type { ChannelTestResult } from '@/lib/api/channels';

/** "Test connection": the adapter's read-only credential check (e.g. Twilio fetches the account); never sends a message. */
export function ChannelTest({ channelId, onHelp, helpIds = [] }: { channelId: string; onHelp?: ((id: string) => void) | undefined; helpIds?: readonly string[] }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ChannelTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run() {
    setError(null);
    start(async () => {
      const r = await testChannelAction(channelId);
      if (r.ok) setResult(r.data);
      else {
        setResult(null);
        setError(r.message);
      }
    });
  }

  return (
    <section className="conn-fieldset" aria-label="Test the connection">
      <span className="legend">Test the connection</span>
      <div className="rowsplit" style={{ flexWrap: 'nowrap' }}>
        <span className="mono-sm">Checks the saved credentials with the provider. Read-only: no message is sent.</span>
        <span className="sp" />
        <button type="button" className="btn tiny" onClick={run} disabled={pending}>
          {pending ? 'Testing…' : 'Test connection'}
        </button>
      </div>
      <div role="status" aria-live="polite">
        {error ? (
          <AlertBanner tone="error" style={{ margin: 0 }}>
            {error}
          </AlertBanner>
        ) : null}
        {result ? (
          <ul className="setup-steps" aria-label="Connection checks">
            {result.checks.map((c) => (
              <li key={c.name}>
                <StatusChip tone={c.ok ? 'good' : 'danger'}>{c.ok ? 'ok' : 'failed'}</StatusChip> {c.name}: {c.detail}
                {c.help && onHelp && helpIds.includes(c.help) ? (
                  <>
                    {' '}
                    <a
                      href={`#ts-${c.help}`}
                      onClick={(e) => {
                        e.preventDefault();
                        onHelp(c.help!);
                      }}
                    >
                      How to fix
                    </a>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
