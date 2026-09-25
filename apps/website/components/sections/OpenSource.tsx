import { REPO_URL, repo } from '@/content/links';
import { SHOTS } from '@/content/shots';
import { ViewOnGitHub } from '../Ctas';
import { ProductShot } from '../ProductShot';
import { Heading } from '../Heading';

const KITS = [
  { title: 'Plugin SDK', pkg: '@winsendotai/ocso-plugin-sdk', body: 'The public contracts for channels, model providers, alert destinations and email drivers, plus a conformance kit. OCSO refuses to start on a version mismatch.', href: repo('packages/ocso-plugin-sdk/README.md') },
  { title: 'Chat SDK', pkg: '@winsendotai/ocso-chat', body: 'A headless client for browsers and React Native, with React hooks and themeable components on top, to build your own chat on OCSO.', href: repo('packages/ocso-chat/README.md') },
  { title: 'MCP tools', pkg: null, body: 'Connect any MCP server over Streamable HTTP with OAuth 2.1. Classify each tool’s risk, approve it per agent, and require a person to confirm sensitive actions.', href: repo('docs/guides/tools/mcp.md') },
];

const COMPOSE = `git clone ${REPO_URL}.git && cd ocso
cp .env.example .env
docker compose up -d --build`;

export function OpenSource() {
  return (
    <section id="open-source" className="mx-auto max-w-6xl scroll-mt-24 px-6 pt-24">
      <Heading
        eyebrow="Open source"
        title="Build on it. Host it. Own it."
        lede="OCSO is a core plus contracts. Everything that touches an outside system is a plugin, and a lint rule fails the build if core code names one. Six model providers ship today: AWS Bedrock, Google Vertex AI, Microsoft Foundry, OpenAI, Anthropic and Sarvam."
      />
      <div className="mt-14 grid gap-4 md:grid-cols-3">
        {KITS.map((k) => (
          <a key={k.title} href={k.href} className="group flex flex-col rounded-3xl border border-fg/10 p-7 transition hover:border-accent/50 hover:bg-accent/[0.06]">
            <p className="text-lg font-medium text-fg">{k.title}</p>
            <p className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              {k.pkg ? (
                <>
                  <code className="font-mono text-fg/60">{k.pkg}</code>
                  <span className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-accent">Coming to npm</span>
                </>
              ) : (
                <span className="rounded-full border border-fg/15 px-2 py-0.5 text-fg/60">Added in the app, no code</span>
              )}
            </p>
            <p className="mt-4 flex-1 text-[15px] text-fg/60">{k.body}</p>
            <p className="mt-5 text-sm text-fg/60 group-hover:text-fg">
              Read the guide <span className="inline-block transition group-hover:translate-x-1">→</span>
            </p>
          </a>
        ))}
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {[SHOTS.models, SHOTS.mcp].map((shot) => (
          <figure key={shot.src}>
            <ProductShot shot={shot} />
            <figcaption className="mt-3 text-sm text-fg/55">
              <span className="font-medium text-fg/80">{shot.caption}.</span> {shot.body}
            </figcaption>
          </figure>
        ))}
      </div>

      <div id="self-host" className="mt-4 scroll-mt-24 grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <div className="rounded-3xl border border-fg/10 p-7">
          <p className="text-lg font-medium text-fg">Docker Compose, on your own server</p>
          <p className="mt-2 text-[15px] text-fg/60">
            The supported deployment: one host with four vCPU and 8 GB of RAM for a pilot, and a Caddy overlay for HTTPS. Single-tenant: one
            deployment belongs to one organization.
          </p>
          <pre className="on-dark mt-5 overflow-x-auto rounded-2xl bg-[#0b1024] p-5 font-mono text-[13px] leading-relaxed text-fg/85" aria-label="Commands: start OCSO with Docker Compose">
            <code>{COMPOSE}</code>
          </pre>
          <a href={repo('docs/guides/deploy/docker-compose.md')} className="mt-5 inline-block text-sm text-accent hover:underline">
            Compose operations guide →
          </a>
        </div>
        <div className="flex flex-col gap-4">
          <div className="rounded-3xl border border-fg/10 p-7">
            <p className="text-lg font-medium text-fg">AWS</p>
            <p className="mt-2 text-[15px] text-fg/60">Terraform for ECS Fargate with S3, SQS and Secrets Manager drivers. Validated, not yet applied to a real account: a starting point.</p>
            <a href={repo('docs/guides/deploy/aws.md')} className="mt-4 inline-block text-sm text-accent hover:underline">
              AWS guide →
            </a>
          </div>
          <div className="rounded-3xl border border-fg/10 p-7">
            <p className="text-lg font-medium text-fg">Hardened by default</p>
            <p className="mt-2 text-[15px] text-fg/60">
              Non-root, read-only containers; the database on a network with no internet access; credentials envelope-encrypted and kept out of
              logs, prompts and audit payloads.
            </p>
          </div>
        </div>
      </div>
      <div className="mt-10 flex flex-col items-center gap-4 text-center">
        <ViewOnGitHub className="inline-flex items-center gap-2.5 rounded-full bg-fg px-6 py-3.5 font-medium text-bg transition hover:bg-fg/85" />
        <p className="text-sm text-fg/45">Apache-2.0. OCSO is pre-1.0: APIs, the schema and plugin contracts can still change.</p>
      </div>
    </section>
  );
}
