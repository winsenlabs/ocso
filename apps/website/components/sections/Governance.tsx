import { repo } from '@/content/links';
import { Heading } from '../Heading';

const PILLARS = [
  {
    title: 'Maker–checker on every configuration change',
    body: 'Agents, prompts, tool grants, routers, queues, SLA policies, channels, providers, MCP connections, SSO, users and permission grants. Each change is a proposal a named second person approves, and the checker approves exactly the content they saw, enforced by content hashes. Stops such as pause, disable and revoke apply at once.',
  },
  {
    title: 'A separate, signed audit store',
    body: 'Audit events commit in the same transaction as the change, then ship to their own append-only database (PostgreSQL or ClickHouse) that the application cannot rewrite. There they are hash-chained, checkpointed with Ed25519 signatures, exported daily and verifiable offline.',
  },
  {
    title: 'A weekly signed exception report',
    body: 'Where the controls were bypassed or failed: configuration live without an approval, self-approvals, rights granted around approval, customers routing could not place, audit events that did not reach the store, a chain that did not verify.',
  },
];

const VERIFY = 'docker compose run --rm migrate \\\n    node audit-store/dist/bin/audit-verify.js';

export function Governance() {
  return (
    <section id="governance" className="mx-auto max-w-6xl scroll-mt-24 px-6 pt-24">
      <Heading
        eyebrow="Governed for real"
        title="Controls an auditor can check, not just trust."
        lede="Built for regulated service teams. Permissions are checked in code, never in a prompt, and nothing a model says can grant one."
      />
      <div className="mt-14 grid gap-4 md:grid-cols-3">
        {PILLARS.map((p, i) => (
          <div key={p.title} className="rounded-3xl border border-fg/10 bg-gradient-to-b from-accent/[0.06] to-transparent p-7">
            <p className="font-mono text-sm text-accent">{String(i + 1).padStart(2, '0')}</p>
            <p className="mt-3 text-lg font-medium text-fg">{p.title}</p>
            <p className="mt-3 text-[15px] leading-relaxed text-fg/60">{p.body}</p>
          </div>
        ))}
      </div>
      <div className="mt-4 grid gap-6 rounded-3xl border border-fg/10 p-7 md:grid-cols-[1fr_1.1fr] md:items-center md:p-9">
        <div>
          <p className="text-lg font-medium text-fg">Roles, and verification you can run yourself</p>
          <p className="mt-3 text-[15px] leading-relaxed text-fg/60">
            Four presets (Tech, Head, Lead, Service), per-user grants with an optional expiry, and team-scoped ownership of agents. Taking access
            away applies at once; widening it needs approval. The audit-verify tool re-checks the hash chain against the signed checkpoints,
            trusting only the public keys you pin.
          </p>
          <a href={repo('docs/15-SECURITY-AND-GOVERNANCE.md')} className="mt-5 inline-block text-sm text-accent hover:underline">
            Security and governance, in detail →
          </a>
        </div>
        <pre className="on-dark overflow-x-auto rounded-2xl bg-[#0b1024] p-5 font-mono text-[13px] leading-relaxed text-fg/85" aria-label="Command: verify the audit chain">
          <code>
            <span className="text-fg/40">$ </span>
            {VERIFY}
          </code>
        </pre>
      </div>
    </section>
  );
}
