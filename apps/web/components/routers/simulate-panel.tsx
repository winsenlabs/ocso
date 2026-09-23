'use client';

import { useState } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { simulateRouterAction } from '@/lib/actions/routers';
import type { Simulation, SimulationTrace } from '@/lib/api/routers';

function line(t: SimulationTrace): { who: string; text: string; tone?: 'decided' | 'muted' } {
  switch (t.kind) {
    case 'customer':
      return { who: 'Customer', text: t.text };
    case 'router':
      return { who: 'Router', text: t.options ? `${t.text}  [${t.options.map((o) => o.label).join(' · ')}]` : t.text };
    case 'classified':
      return {
        who: 'Classifier',
        text: t.source === 'error' ? `model failed (${t.error ?? 'error'}): left unset` : t.label ? `${t.label} (confidence ${t.confidence.toFixed(2)}, ${t.source})` : `unclassified (${t.source})${t.followUp ? ` · follow-up: ${t.followUp}` : ''}`,
        tone: 'muted',
      };
    case 'decided':
      return { who: 'Decision', text: `${t.queueName ?? 'queue'} · ${t.agentName ?? 'no agent'} — ${t.reason}`, tone: 'decided' };
    case 'continued':
      return { who: 'Decision', text: `continues the earlier conversation (${t.outcome.toLowerCase()})`, tone: 'decided' };
    case 'new_conversation':
      return { who: 'Decision', text: 'starts a new conversation', tone: 'decided' };
    case 'waiting':
      return { who: 'Waiting', text: t.text, tone: 'muted' };
  }
}

/**
 * Simulate (PM/research/11 §5.7): the same state machine production runs, fed
 * the messages typed here (one per line: the first opens the conversation,
 * the rest answer the router). Nothing is sent or written; the model runs
 * only for people who may change routers.
 */
export function SimulatePanel({ routerId, versions }: { routerId: string; versions: Array<{ id: string; version: number }> }) {
  const [messages, setMessages] = useState('hello\nTamil');
  const [language, setLanguage] = useState('');
  const [versionId, setVersionId] = useState('');
  const [result, setResult] = useState<Simulation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    const lines = messages.split('\n').map((m) => m.trim()).filter(Boolean);
    const r = await simulateRouterAction(routerId, { messages: lines, ...(versionId ? { versionId } : {}), ...(language.trim() ? { language: language.trim() } : {}) });
    setBusy(false);
    if (r.ok) setResult(r.data);
    else setError(r.message);
  }

  return (
    <section className="rt-panel" aria-label="Simulate">
      <h3 className="rt-h">Simulate</h3>
      <div className="fld">
        <label htmlFor="rt-sim-messages">Customer messages (one per line)</label>
        <textarea id="rt-sim-messages" rows={3} value={messages} onChange={(e) => setMessages(e.target.value)} />
      </div>
      <div className="fld-row">
        <div className="fld">
          <label htmlFor="rt-sim-version">Run</label>
          <select id="rt-sim-version" value={versionId} onChange={(e) => setVersionId(e.target.value)}>
            <option value="">the saved draft</option>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                version {v.version}
              </option>
            ))}
          </select>
        </div>
        <div className="fld">
          <label htmlFor="rt-sim-lang">Customer language (known facts)</label>
          <input id="rt-sim-lang" value={language} placeholder="e.g. ta" onChange={(e) => setLanguage(e.target.value)} />
        </div>
      </div>
      <button type="button" className="btn tiny accent" disabled={busy || !messages.trim()} onClick={() => void run()}>
        {busy ? 'Running…' : 'Run simulation'}
      </button>
      {error ? (
        <AlertBanner tone="error" style={{ margin: 0 }}>
          {error}
        </AlertBanner>
      ) : null}
      {result ? (
        <ol className="rt-trace" aria-label="Decision trace">
          {result.trace.map((t, i) => {
            const l = line(t);
            return (
              <li key={i} className={l.tone ? `rt-${l.tone}` : undefined}>
                <span className="mono-sm">{l.who}</span>
                <span>{l.text}</span>
              </li>
            );
          })}
        </ol>
      ) : null}
      {result && !result.decision ? <p className="mono-sm">No decision yet: the router is still waiting for an answer.</p> : null}
    </section>
  );
}
