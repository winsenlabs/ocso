import { repo } from '@/lib/site';
import { Icon, type IconName } from './icons';
import { Section } from './section';

interface Kit {
  readonly icon: IconName;
  readonly title: string;
  readonly pkg: string | null;
  readonly body: string;
  readonly href: string;
  readonly linkLabel: string;
}

const KITS: readonly Kit[] = [
  {
    icon: 'plug',
    title: 'Plugin SDK',
    pkg: '@winsendotai/ocso-plugin-sdk',
    body: 'The public contracts for channels, model providers, alert destinations and email drivers, plus a checkPlugin conformance kit. The operator pins each plugin’s exact version; OCSO refuses to start on a mismatch.',
    href: repo('packages/ocso-plugin-sdk/README.md'),
    linkLabel: 'Plugin SDK guide',
  },
  {
    icon: 'code',
    title: 'Chat SDK',
    pkg: '@winsendotai/ocso-chat',
    body: 'A headless client for browsers and React Native, and React hooks and themeable components on top. Anonymous visitors, session passes from your backend, or your own signed-in users.',
    href: repo('packages/ocso-chat/README.md'),
    linkLabel: 'Chat SDK guide',
  },
  {
    icon: 'tool',
    title: 'MCP tools',
    pkg: null,
    body: 'Connect any MCP server over Streamable HTTP with OAuth 2.1. Classify each tool’s risk, approve it per agent, add argument rules and require a person to confirm sensitive actions.',
    href: repo('docs/plugins/tools-and-mcp.md'),
    linkLabel: 'Tools and MCP',
  },
];

const SNIPPET = `import { definePlugin } from '@winsendotai/ocso-plugin-sdk';

export default definePlugin({
  apiVersion: 1,
  name: '@acme/ocso-channel-line',
  channels: [createLineAdapter],
});`;

export function Build() {
  return (
    <Section
      id="build"
      index="05"
      eyebrow="Build on it"
      title="The plugin boundary is the product."
      intro="OCSO is a core plus contracts. Everything that touches an outside system is a plugin looked up by kind, and core code never names one. A lint rule fails the build if it does."
      tone="tint"
    >
      <ul className="kit-grid">
        {KITS.map((k) => (
          <li key={k.title} className="card kit">
            <span className="kit-icon">
              <Icon name={k.icon} size={22} />
            </span>
            <h3>{k.title}</h3>
            {k.pkg ? (
              <p className="kit-pkg">
                <code>{k.pkg}</code>
                <span className="badge">Coming to npm</span>
              </p>
            ) : (
              <p className="kit-pkg">
                <span className="badge badge-quiet">Added in the app</span>
              </p>
            )}
            <p>{k.body}</p>
            <a className="text-link" href={k.href}>
              {k.linkLabel}
            </a>
          </li>
        ))}
      </ul>

      <div className="build-split">
        <pre className="code" aria-label="Example: a channel plugin">
          <code>{SNIPPET}</code>
        </pre>
        <div>
          <h3>Models are plugins too</h3>
          <p>
            Six model providers ship today: AWS Bedrock, Google Vertex AI, Microsoft Foundry, OpenAI, Anthropic and
            Sarvam, each with its own prompt-caching strategy. Agents use logical model profiles with ordered fallbacks,
            checked against a deployment policy for allowed providers and data residency.
          </p>
          <p className="muted">
            Plugins run in-process with full trust, so install only code you trust. The SDK packages live in this
            repository today and are coming to npm.
          </p>
          <p>
            <a className="text-link" href={repo('docs/plugins/')}>
              All extension points
            </a>
          </p>
        </div>
      </div>
    </Section>
  );
}
