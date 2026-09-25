import { repo } from '@/lib/site';
import { Icon, type IconName } from './icons';
import { Section } from './section';
import { Shot } from './shot';

const ROLES = [
  { name: 'Tech', body: 'Runs the platform: providers, channels, MCP, users, settings and audit verification. Never reads conversation content.' },
  { name: 'Head', body: 'Full authority inside their teams. Checks Leads’ and other Heads’ changes, and signs the exception report.' },
  { name: 'Lead', body: 'Runs their teams’ agents, prompts, queues and routers. Proposes changes, but cannot check them.' },
  { name: 'Service', body: 'Handles the conversations in their teams’ queues, takes over from the AI and hands back.' },
] as const;

const PILLARS: readonly { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'users',
    title: 'Maker–checker on every configuration change',
    body: 'Agents, prompts, tool grants, routers, queues, SLA policies, channels, providers, MCP connections, SSO, users and permission grants: each change is a proposal that a named second person approves. The checker approves exactly the content they saw, enforced by content hashes. Stops such as pause, disable and revoke apply at once.',
  },
  {
    icon: 'chain',
    title: 'A separate, tamper-evident audit store',
    body: 'Audit events commit in the same transaction as the change, then ship to their own database, which the application’s credentials cannot rewrite: PostgreSQL (append-only by trigger) or ClickHouse. There they are hash-chained, checkpointed with Ed25519 signatures, exported daily and verifiable offline.',
  },
  {
    icon: 'report',
    title: 'A weekly signed exception report',
    body: 'Where the controls were bypassed or failed: configuration live without an approval, self-approvals, rights granted around approval, customers routing could not place, audit events that did not reach the store, a chain that did not verify. Signed with the audit key and scoped by team.',
  },
];

/** As in the Dockerfile's migrate stage: the audit store tools ship in the migrate image. */
const VERIFY_COMMAND = 'docker compose run --rm migrate \\\n    node audit-store/dist/bin/audit-verify.js';

export function Governance() {
  return (
    <Section
      id="governance"
      index="03"
      eyebrow="Governance and audit"
      title="Controls an auditor can check, not just trust."
      intro="Built for regulated service teams. Permissions are checked in code, never in a prompt. Nothing a model says can grant a permission."
      tone="ink"
    >
      <div className="roles">
        <h3 className="sub-title">Four role presets</h3>
        <ul className="role-grid">
          {ROLES.map((r) => (
            <li key={r.name} className="role">
              <p className="role-name">{r.name}</p>
              <p>{r.body}</p>
            </li>
          ))}
        </ul>
        <p className="footnote">
          On top of a preset, a user can get per-user grants, optionally with an expiry, and revokes. Taking access away
          applies at once; widening it needs approval. Heads and Leads see only the agents their teams own.
        </p>
      </div>

      <ul className="pillars">
        {PILLARS.map((p) => (
          <li key={p.title} className="pillar">
            <span className="pillar-icon">
              <Icon name={p.icon} size={22} />
            </span>
            <h3>{p.title}</h3>
            <p>{p.body}</p>
          </li>
        ))}
      </ul>

      <div className="verify">
        <div>
          <h3>Verify it yourself</h3>
          <p>
            The audit-verify tool re-checks any range of the hash chain against the signed checkpoints, trusting only the
            public keys you pin. When nobody else can check a change, such as a deployment with a single Tech
            admin, the maker&rsquo;s own approval is recorded as a bootstrap approval and shows up in the exception report.
          </p>
          <p>
            <a className="text-link" href={repo('docs/15-SECURITY-AND-GOVERNANCE.md')}>
              Security and governance, in detail
            </a>
          </p>
        </div>
        <pre className="code" aria-label="Command: verify the audit chain">
          <code>
            <span className="code-dim">$ </span>
            {VERIFY_COMMAND}
          </code>
        </pre>
      </div>

      <Shot id="approvals" className="shot-on-ink" caption="Approvals: each proposal shows its maker, its reason, its content hash and exactly what would change." />
    </Section>
  );
}
