import { AlertBanner } from '@/components/ui/alert-banner';
import { EmptyState } from '@/components/ui/empty-state';
import { SecHead } from '@/components/ui/sec-head';

export const CONNECTION_TABS = [
  { key: 'providers', label: 'Model providers' },
  { key: 'mcp', label: 'MCP connections' },
  { key: 'channels', label: 'Channels' },
  { key: 'secrets', label: 'Secrets & credentials' },
  { key: 'webhooks', label: 'Webhooks' },
] as const;
export type ConnectionTab = (typeof CONNECTION_TABS)[number]['key'];

export function parseConnectionTab(value: unknown): ConnectionTab {
  return CONNECTION_TABS.find((t) => t.key === value)?.key ?? 'providers';
}

const COPY: Record<ConnectionTab, { heading: string; desc: string; title: string; body: string }> = {
  providers: {
    heading: 'Model providers',
    desc: 'agents reference logical profiles, never provider model IDs',
    title: 'No model providers configured yet',
    body: 'AWS Bedrock, Google Vertex AI, Microsoft Foundry, OpenAI, Anthropic and Sarvam connections — region, credential reference, caching and health — and the logical model profiles that point at them will appear here once the providers API is connected.',
  },
  mcp: {
    heading: 'MCP connections',
    desc: 'no code, no restart — discovery and consent are the whole job',
    title: 'No MCP servers connected yet',
    body: 'MCP servers with their URL, auth, scope, discovered tools, health and last sync — and the six-step add-server flow (URL, discover, authenticate, review, approve, active) — will appear here once the MCP API is connected.',
  },
  channels: {
    heading: 'Channels',
    desc: 'adapters normalise transport into OCSO interactions',
    title: 'No channels configured yet',
    body: 'WhatsApp, web chat, mobile app, email, Instagram, SMS and voice adapters — status, webhook verification, assigned agents and supported media — will appear here once the channels API is connected.',
  },
  secrets: {
    heading: 'Secrets & credentials',
    desc: 'references only; values never leave the secret store',
    title: 'No secret references yet',
    body: 'Secret references — type, what uses them, rotation and expiry — will appear here once the secrets API is connected.',
  },
  webhooks: {
    heading: 'Webhooks',
    desc: 'inbound channel callbacks and outbound event delivery',
    title: 'No webhook endpoints yet',
    body: 'Inbound channel callbacks and outbound event subscriptions — events, direction, 24h volume, failures and verification state — will appear here once the webhooks API is connected.',
  },
};

/** One tab of Connections & models (design/04) while its API is being built. */
export function ConnectionTabPanel({ tab }: { tab: ConnectionTab }) {
  const c = COPY[tab];
  return (
    <>
      {tab === 'secrets' ? (
        <AlertBanner title="PostgreSQL stores references only.">
          Values live in the configured secret store and are resolved inside trusted execution code. They are never placed in prompts, telemetry or
          tool arguments.
        </AlertBanner>
      ) : null}
      <SecHead title={c.heading} desc={c.desc} />
      <EmptyState title={c.title}>{c.body}</EmptyState>
    </>
  );
}
