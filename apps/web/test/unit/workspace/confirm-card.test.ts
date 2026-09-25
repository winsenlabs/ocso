import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The real module is a 'use server' file bound to the API client; the card only needs the references.
vi.mock('../../../lib/actions/conversations', () => ({ confirmToolCallAction: vi.fn(), denyToolCallAction: vi.fn() }));

const { ConfirmCard } = await import('../../../components/workspace/confirm-card');

const NOW = Date.parse('2026-09-22T09:52:00Z');
const call = {
  id: '0199aa00-0000-7000-8000-000000000001',
  toolName: 'Reverse a settled debit',
  connectionName: 'core-cards',
  riskClass: 'SENSITIVE',
  args: { cif: '88214', txnId: 'TXN-8841-2290', amountMinor: 1248000, reason: 'duplicate EMI debit', card: { last4: '4417' } },
  reason: 'sensitive action requires confirmation',
  expiresAt: new Date(NOW + 252_000).toISOString(),
  requestedBy: 'AGENT',
};
const render = (props: Partial<Parameters<typeof ConfirmCard>[0]> = {}) =>
  renderToStaticMarkup(createElement(ConfirmCard, { call, agentName: 'Maya', now: NOW, canDecide: true, ...props }));

describe('sensitive-tool confirmation card (docs/archive/specs/08 §7, design/01 .confirm)', () => {
  it('shows the tool, who proposed it, the policy reason, risk, sanitized args and expiry', () => {
    const html = render();
    expect(html).toContain('confirm sensitive action');
    expect(html).toContain('<b>Reverse a settled debit</b>');
    expect(html).toContain('core-cards');
    expect(html).toContain('Maya proposed this action');
    expect(html).toContain('sensitive action requires confirmation');
    expect(html).toContain('class="risk s"'); // 2-step badge
    expect(html).toContain('txn id <b>TXN-8841-2290</b>');
    expect(html).toContain('amount minor <b>1248000</b>');
    expect(html).not.toContain('last4'); // nested objects are not flattened into facts
    expect(html).toContain('expires in 04:12');
    expect(html).toContain('>Confirm and run</button>');
    expect(html).toContain('>Deny</button>');
  });

  it('is read-only for a role without tools.confirm_sensitive', () => {
    const html = render({ canDecide: false });
    expect(html).not.toContain('Confirm and run');
    expect(html).toContain('your role cannot confirm sensitive actions');
  });

  it('stops offering the decision once the confirmation window has expired', () => {
    const html = render({ now: NOW + 300_000 });
    expect(html).not.toContain('Confirm and run');
    expect(html).toContain('confirmation window expired');
  });
});
