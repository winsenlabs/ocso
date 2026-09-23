import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ROLE_PERMISSIONS } from '@ocso/auth';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock('../../../lib/actions/home', () => ({ takeNextAction: vi.fn() }));

const { AskOcsoProvider } = await import('../../../components/shell/ask-ocso-context');
const { NeedsYou } = await import('../../../components/home/needs-you');
const { TrendTile, TrendTiles } = await import('../../../components/home/trend-tiles');
const { forYouItems } = await import('../../../components/home/exec-home');
const { decisionItems } = await import('../../../components/home/lead-home');
const { askOcsoCopy } = await import('../../../components/shell/ask-ocso-copy');
const { SetupChecklist, setupOwner } = await import('../../../components/home/setup-checklist');
const { ServiceFlow } = await import('../../../components/home/service-flow');
const { AskOcsoBar } = await import('../../../components/home/ask-ocso-bar');
const { HomeFrame } = await import('../../../components/home/home-frame');
const { TakeNextButton } = await import('../../../components/home/take-next');
const { Composer } = await import('../../../components/internal-agent/composer');
const { Sidebar } = await import('../../../components/ui/sidebar');

const inProvider = (el: ReactElement) => renderToStaticMarkup(createElement(AskOcsoProvider, null, el));
const now = new Date('2026-09-24T10:30:00Z');

describe('needs you list', () => {
  const items = [
    {
      id: 'alert:1',
      kind: 'alert',
      severity: 'critical' as const,
      title: 'Provider errors above 5%',
      detail: 'openai · 7.2%',
      at: '2026-09-24T10:10:00Z',
      href: '/alerts?alert=1',
      askOcso: 'Why are provider errors high?',
    },
    { id: 'approval:2', kind: 'approval_to_decide', severity: 'normal' as const, title: 'Maya prompt v4', at: '2026-09-24T08:30:00Z', href: '/approvals?proposal=2' },
  ];

  it('is an ordered list with severity for screen readers, age, link and an Ask OCSO button when a question is ready', () => {
    const html = inProvider(createElement(NeedsYou, { items, canAsk: true, now }));
    expect(html).toContain('<ol class="ny-list" aria-label="Needs you, most urgent first">');
    expect(html).toContain('<span class="sr-only">Critical: </span>Provider errors above 5%');
    expect(html).toContain('href="/alerts?alert=1"');
    expect(html).toContain('20m ago');
    expect(html).toContain('aria-label="Ask OCSO about Provider errors above 5%"');
    // Only the item with a ready question gets the button.
    expect(html.match(/Ask OCSO about/g)).toHaveLength(1);
    expect(html).toContain('2 · 1 critical');
  });

  it('hides Ask OCSO when the user cannot use it, and says plainly when nothing needs them', () => {
    expect(inProvider(createElement(NeedsYou, { items, canAsk: false, now }))).not.toContain('Ask OCSO about');
    expect(inProvider(createElement(NeedsYou, { items: [], canAsk: true, now }))).toContain('Nothing needs you right now.');
  });

  it('folds everything past the limit into a disclosure', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ ...items[1]!, id: `a:${i}`, title: `Item ${i}` }));
    const html = inProvider(createElement(NeedsYou, { items: many, canAsk: false, now, limit: 8 }));
    expect(html).toContain('<summary>3 more</summary>');
    expect(html).toContain('start="9"');
  });
});

describe('trend tiles', () => {
  it('links, colours the delta by direction and speaks the change', () => {
    const html = renderToStaticMarkup(
      createElement(TrendTile, { tile: { key: 'esc', label: 'escalation rate', value: 0.3, unit: '%', previous: 0.2, betterWhen: 'down', href: '/escalation-reasons' }, period: 'previous 7 days' }),
    );
    expect(html).toContain('href="/escalation-reasons"');
    expect(html).toContain('30.0%');
    expect(html).toContain('class="tt-delta bad"');
    expect(html).toContain('<span class="sr-only">up 10 pts vs previous 7 days</span>');
  });

  it('shows no data rather than zero, and renders nothing without tiles', () => {
    const html = renderToStaticMarkup(createElement(TrendTile, { tile: { key: 'k', label: 'csat', value: null, previous: null, betterWhen: 'up' }, period: 'x' }));
    expect(html).toContain('no data yet');
    expect(html).toContain('nodata');
    expect(renderToStaticMarkup(createElement(TrendTiles, { tiles: [], period: 'x', label: 'Key numbers' }))).toBe('');
    const live = renderToStaticMarkup(
      createElement(TrendTile, { tile: { key: 'w', label: 'Waiting', value: 2, unit: 'count', previous: null, betterWhen: 'down', period: 'now' }, period: 'yesterday' }),
    );
    expect(live).toContain('right now');
    const today = renderToStaticMarkup(
      createElement(TrendTile, { tile: { key: 'r', label: 'Resolved today', value: 6, unit: 'count', previous: 4, betterWhen: 'up', period: 'today' }, period: 'previous 7 days' }),
    );
    expect(today).toContain('up 50% vs yesterday');
  });
});

describe('setup checklist', () => {
  const tech = new Set<string>(ROLE_PERMISSIONS.TECH);
  const head = new Set<string>(ROLE_PERMISSIONS.HEAD);

  it('counts progress and points at the first open step', () => {
    const html = renderToStaticMarkup(
      createElement(SetupChecklist, {
        permissions: head,
        steps: [
          { key: 'model', label: 'Connect a model', done: true, href: '/connections?tab=providers' },
          { key: 'agent', label: 'Create your first agent', done: false, href: '/agents' },
          { key: 'channel', label: 'Add a channel', done: false, href: '/connections?tab=channels' },
        ],
      }),
    );
    expect(html).toContain('1 of 3 done');
    expect(html).toContain('aria-valuenow="1"');
    expect(html).toContain('<li class="next">');
    expect(html).toContain('Create your first agent<span class="sr-only"> (next step)</span>');
    expect(html).toContain('Connect a model<span class="sr-only"> (done)</span>');
  });

  it("never sends someone to a step they cannot do: it reads 'waiting on <role>' and the next step is one they can do", () => {
    const steps = [
      { key: 'model', label: 'Connect a model', done: true, href: '/connections?tab=providers' },
      { key: 'agent', label: 'Create your first agent', done: false, href: '/agents' },
      { key: 'channel', label: 'Open a channel', done: false, href: '/connections?tab=channels' },
      { key: 'go_live', label: 'Route a channel to a live agent', done: false, href: '/routers' },
      { key: 'ask_ocso', label: 'Choose the model Ask OCSO runs on', done: false, href: '/settings' },
    ];
    const asTech = renderToStaticMarkup(createElement(SetupChecklist, { steps, permissions: tech }));
    expect(asTech).not.toContain('href="/agents"');
    expect(asTech).not.toContain('href="/routers"');
    expect(asTech).toContain('Create your first agent<span class="setup-owner mono-sm"> · waiting on Head</span>');
    expect(asTech).toContain('Open a channel<span class="sr-only"> (next step)</span>');
    const asHead = renderToStaticMarkup(createElement(SetupChecklist, { steps, permissions: head }));
    expect(asHead).not.toContain('href="/settings"');
    expect(asHead).toContain('Choose the model Ask OCSO runs on<span class="setup-owner mono-sm"> · waiting on Tech</span>');
    expect(asHead).toContain('Create your first agent<span class="sr-only"> (next step)</span>');
    expect(setupOwner('agent', head)).toBeNull();
    expect(setupOwner('some_new_step', new Set())).toBeNull();
    const nobody = renderToStaticMarkup(createElement(SetupChecklist, { steps: steps.slice(1, 2), permissions: new Set<string>() }));
    expect(nobody).not.toContain('Start');
  });

  it('replaces the tiles on Home while setup is incomplete', () => {
    const props = { name: 'Tara', tail: 'hi', strip: [], ask: null, needsYou: [], period: 'previous 7 days', permissions: new Set<string>(ROLE_PERMISSIONS.TECH), now, children: null };
    const tiles = [{ key: 'a', label: 'uptime', value: 1, unit: '%' as const, previous: 1, betterWhen: 'up' as const }];
    const settingUp = inProvider(createElement(HomeFrame, { ...props, tiles, setup: { complete: false, steps: [{ key: 'model', label: 'Connect a model', done: false, href: '/x' }] } }));
    expect(settingUp).toContain('Set up OCSO');
    expect(settingUp).not.toContain('trend-tiles');
    expect(settingUp).not.toContain('home-ask');
    const done = inProvider(createElement(HomeFrame, { ...props, tiles, ask: [{ label: 'What needs me?', prompt: 'What needs my attention?' }], setup: { complete: true, steps: [] } }));
    expect(done).not.toContain('Set up OCSO');
    expect(done).toContain('trend-tiles');
    expect(done).toContain('aria-label="Ask OCSO"');
    expect(done).toContain('What needs me?');
  });
});

describe('service flow', () => {
  const flow = {
    channels: [
      { id: 'c1', name: 'Web chat', kind: 'WEBCHAT', status: 'ACTIVE', conversations24h: 120 },
      { id: 'c2', name: 'WhatsApp', kind: 'WHATSAPP', status: 'FAILING', conversations24h: 4, problem: '3 failed deliveries' },
    ],
    routers: [{ id: 'r1', name: 'Front door', status: 'ACTIVE', channelIds: ['c1', 'c2'], routed24h: 118, stuck: 2 }],
    queues: [{ id: 'q1', name: 'Cards', routerIds: ['r1'], agentId: 'a1', waiting: 3, oldestWaitSeconds: 250, slaAtRisk: 1 }],
    agents: [{ id: 'a1', name: 'Maya', status: 'LIVE', queueIds: ['q1'], conversations24h: 110, containment: 0.8, escalations24h: 9 }],
  };

  it('is four labelled lists with volumes, upstream names, problem badges and links the user may open', () => {
    const html = renderToStaticMarkup(createElement(ServiceFlow, { flow, links: { channels: false, routers: true, queues: true, agents: true } }));
    for (const col of ['channels', 'routers', 'queues', 'agents']) expect(html).toContain(`<ul aria-labelledby="flow-${col}">`);
    expect(html).toContain('from Web chat, WhatsApp');
    expect(html).toContain('2 stuck in routing');
    expect(html).toContain('3 failed deliveries');
    expect(html).toContain('1 SLA at risk');
    expect(html).toContain('href="/routers/r1"');
    expect(html).toContain('href="/agents/a1"');
    expect(html).toContain('80% contained');
    expect(html).toContain('<span class="fn-status">failing</span>');
    // No channel permission: the channel names are text, not links.
    expect(html).not.toContain('tab=channels');
  });

  it('says so when there is nothing to draw', () => {
    const html = renderToStaticMarkup(
      createElement(ServiceFlow, { flow: { channels: [], routers: [], queues: [], agents: [] }, links: { channels: true, routers: true, queues: true, agents: true } }),
    );
    expect(html).toContain('No channel, router or queue yet');
  });
});

describe('Ask OCSO bar and take next', () => {
  it('is a labelled search form with chips', () => {
    const html = inProvider(createElement(AskOcsoBar, { chips: [{ label: 'Which agent escalates most?', prompt: 'Which agent is escalating most often?' }] }));
    expect(html).toContain('role="search"');
    expect(html).toContain('<label class="sr-only" for="home-ask-input">Ask OCSO</label>');
    expect(html).toContain('title="Which agent is escalating most often?"');
  });

  it('take next is disabled with nobody waiting', () => {
    expect(renderToStaticMarkup(createElement(TakeNextButton, { available: false, waiting: 0 }))).toContain('disabled=""');
    expect(renderToStaticMarkup(createElement(TakeNextButton, { available: true, waiting: 3 }))).toContain('3 waiting');
  });

  it('the drawer composer takes a handed-over question into the ask box', () => {
    const props = {
      id: 'd',
      inputRef: { current: null },
      roleChip: 'role: service',
      suggestions: [],
      disabled: false,
      working: false,
      attachContext: true,
      contextLabel: 'home',
      onToggleContext: () => {},
      onSend: () => {},
      onStop: () => {},
    };
    expect(renderToStaticMarkup(createElement(Composer, { ...props, prefill: { id: 1, text: 'Review proposal Maya v4 waiting on me' } }))).toContain(
      '>Review proposal Maya v4 waiting on me</textarea>',
    );
    expect(renderToStaticMarkup(createElement(Composer, props))).toContain('></textarea>');
  });
});

describe('needs you merges', () => {
  const at = '2026-09-24T10:00:00.000Z';
  it('shows a conversation offered to me once, from the API list, not again as an offer', () => {
    const ranked = [{ id: 'conversation:c1', kind: 'escalation_waiting', severity: 'high' as const, title: 'Asha is waiting for you', at, href: '/conversations/c1' }];
    const offers = [
      { kind: 'offer' as const, conversationId: 'c1', customerName: 'Asha', priority: 'P2', waitingSince: at },
      { kind: 'offer' as const, conversationId: 'c2', customerName: 'Ravi', priority: 'P2', waitingSince: at },
    ];
    expect(forYouItems(offers, ranked).map((i) => i.id)).toEqual(['offer:c2']);
  });

  it('drops an understaffed-queue decision when the API already lists that queue', () => {
    const ranked = [{ id: 'queue:q1', kind: 'sla_at_risk', severity: 'high' as const, title: '3 waiting in Cards', at, href: '/conversations?view=waiting' }];
    const decisions = [
      { kind: 'understaffed_queue' as const, queueId: 'q1', queueName: 'Cards', waiting: 3, onShift: 0, members: 4 },
      { kind: 'understaffed_queue' as const, queueId: 'q2', queueName: 'Loans', waiting: 2, onShift: 0, members: 3 },
      { kind: 'prompt_corrections' as const, agentId: 'a1', agentName: 'Maya', open: 2, staged: 0 },
    ];
    expect(decisionItems(decisions, ranked, at).map((i) => i.id)).toEqual(['decision:understaffed_queue:q2', 'decision:prompt_corrections:a1']);
  });
});

describe('no environment label', () => {
  it('the Ask OCSO drawer scope line names the region, never the deployment label', () => {
    const session = (region: string | null) =>
      ({ role: 'TECH', roleLabel: 'Tech', permissions: new Set(ROLE_PERMISSIONS.TECH), user: { name: 'Tara Admin', deployment: { label: 'PROD', region } } }) as never;
    expect(askOcsoCopy(session('ap-south-1'), 'TA').scopeLine).toBe('scope · platform · ap-south-1');
    expect(askOcsoCopy(session(null), 'TA').scopeLine).toBe('scope · platform');
  });
});

describe('sidebar', () => {
  it('has no deployment scope box or environment badge', () => {
    const html = renderToStaticMarkup(createElement(Sidebar, { region: 'ap-south-1', groups: [], user: { initials: 'TA', name: 'Tara Admin', roleLabel: 'Tech' } }));
    expect(html).not.toContain('scope-sw');
    expect(html).not.toMatch(/PROD|single tenant/i);
    expect(html).toContain('ap-south-1');
  });
});
