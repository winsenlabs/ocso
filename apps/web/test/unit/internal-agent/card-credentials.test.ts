import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ActionCard, readCredentials } from '../../../components/internal-agent/action-card';
import { decisionFailure, fromAnswer, readActionAnswer, readReveal, withoutReveal } from '../../../components/internal-agent/decisions';
import type { ActionCardData } from '../../../components/internal-agent/types';
import { ApiError } from '../../../lib/api/errors';

vi.mock('../../../lib/actions/internal-agent', () => ({ confirmAskOcsoAction: vi.fn(), rejectAskOcsoAction: vi.fn() }));

/** Credentials typed on the card and secrets shown once (PM/research/12 §9). */

const FUTURE = new Date(Date.now() + 15 * 60_000).toISOString();

const card: ActionCardData = {
  id: '0199aaaa-0000-7000-8000-000000000011',
  tool: 'channels.create_channel',
  title: 'Create channel',
  summary: 'Create a channel as a draft.',
  kind: 'direct',
  changes: [{ label: 'name', before: null, after: 'Site chat' }],
  warnings: [],
  credentials: [
    { key: 'visitorTokenSecret', label: 'Visitor token secret', required: false, generate: true, hint: 'Signs anonymous visitor sessions.' },
    { key: 'authToken', label: 'Auth token', required: true },
  ],
  expiresAt: FUTURE,
  status: 'PENDING',
};

const render = (c: ActionCardData) => renderToStaticMarkup(createElement(ActionCard, { action: c, decision: undefined, onDecided: () => {}, userName: 'Tia Tech' }));

describe('credential fields on a card', () => {
  it('renders labelled password inputs that browsers do not fill or remember', () => {
    const html = render(card);
    expect(html).toContain('<form class="ia-card-form" noValidate="" autoComplete="off"');
    expect(html.match(/type="password"/g)).toHaveLength(2);
    expect(html).toMatch(/<label for="[^"]+-cred-authToken">Auth token<span class="ia-req"> \(required\)<\/span><\/label>/);
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain('spellCheck="false"');
    expect(html).toContain('Leave blank to generate');
    expect(html).toContain('Signs anonymous visitor sessions.');
  });

  it('shows no credential fields once the card is decided, and none on a card without them', () => {
    expect(render({ ...card, status: 'EXECUTED', result: { message: 'Done.' } })).not.toContain('type="password"');
    expect(render({ ...card, credentials: null })).not.toContain('type="password"');
  });

  it('reads typed values from the form: blanks dropped, missing required fields named', () => {
    const form = new Map<string, string>([
      ['credential:visitorTokenSecret', ''],
      ['credential:authToken', '  '],
    ]);
    expect(readCredentials(card.credentials!, { get: (k: string) => form.get(k) ?? null })).toEqual({ values: {}, missing: ['Auth token'] });
    form.set('credential:authToken', 'tok-123');
    expect(readCredentials(card.credentials!, { get: (k: string) => form.get(k) ?? null })).toEqual({ values: { authToken: 'tok-123' }, missing: [] });
  });

  it('a credential refusal from the API points at the credential fields', () => {
    const err = new ApiError({ status: 400, category: 'validation', code: 'credential_required', message: 'Enter Auth token on the card.' });
    expect(decisionFailure(err)).toEqual({ ok: false, message: 'Enter Auth token on the card.', settled: null, field: 'credentials' });
  });
});

describe('secrets shown once', () => {
  const answer = { ...card, status: 'EXECUTED', result: { message: 'Created as a draft. Secret key issued and shown once to the user.' }, reveal: [{ key: 'secretKey', label: 'Secret key', value: 'sk_live' }, { key: 'x' }] };

  it('the confirm answer carries the reveal beside the card, never inside it', () => {
    const read = readActionAnswer(answer, 'confirm');
    expect(read).toMatchObject({ reveal: [{ key: 'secretKey', label: 'Secret key', value: 'sk_live' }] });
    expect(JSON.stringify((read as { card: unknown }).card)).not.toContain('sk_live');
    const decision = fromAnswer(read, 'EXECUTED');
    expect(decision).toMatchObject({ ok: true, reveal: [{ value: 'sk_live' }] });
    // What the drawer keeps has no secret.
    expect(JSON.stringify(withoutReveal(decision))).not.toContain('sk_live');
  });

  it('reject answers and malformed reveals carry nothing', () => {
    expect(JSON.stringify(readActionAnswer(answer, 'reject'))).not.toContain('sk_live');
    expect(readReveal({ reveal: 'sk_live' })).toEqual([]);
    expect(readReveal({ reveal: [{ key: 'k', label: 'L', value: '' }] })).toEqual([]);
    expect(readReveal(null)).toEqual([]);
  });
});
