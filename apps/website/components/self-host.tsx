import { repo } from '@/lib/site';
import { Icon } from './icons';
import { Section } from './section';

const COMPOSE = `git clone https://github.com/winsenlabs/ocso.git && cd ocso
cp .env.example .env
docker compose up -d --build`;

const DEMO = `OCSO_DEMO_SEED=true docker compose --profile demo up -d --build`;

const HARDENING = [
  'Non-root containers with read-only root filesystems, no new privileges and every capability dropped',
  'PostgreSQL on a network with no internet access; only the web app is published',
  'Bootstrap secrets generated on first start; stored credentials envelope-encrypted and kept out of logs, prompts and audit payloads',
  'Workers lease conversations: kill one mid-turn and another resumes it',
] as const;

export function SelfHost() {
  return (
    <Section
      id="self-host"
      index="06"
      eyebrow="Self-host it"
      title="Your servers, your models, your data."
      intro="One deployment belongs to one organization: single-tenant, multi-user. The customer conversation, the model choice and the data stay under your control."
    >
      <div className="host-grid">
        <div className="card host">
          <span className="kit-icon">
            <Icon name="server" size={22} />
          </span>
          <h3>Docker Compose</h3>
          <p>The supported deployment: one host, four vCPU and 8 GB of RAM for a pilot. A Caddy overlay adds HTTPS with automatic certificates.</p>
          <pre className="code code-sm" aria-label="Commands: start OCSO with Docker Compose">
            <code>{COMPOSE}</code>
          </pre>
          <p className="muted">Or start the demo bank, which needs no model provider keys:</p>
          <pre className="code code-sm" aria-label="Command: start the Meridian Bank demo">
            <code>{DEMO}</code>
          </pre>
          <a className="text-link" href={repo('docs/operations/compose.md')}>
            Compose operations guide
          </a>
        </div>
        <div className="host-side">
          <div className="card host">
            <span className="kit-icon">
              <Icon name="cloud" size={22} />
            </span>
            <h3>AWS</h3>
            <p>
              Terraform for ECS Fargate, with drivers for S3, SQS and Secrets Manager. It is validated but not yet applied
              to a real account, so treat it as a starting point.
            </p>
            <a className="text-link" href={repo('docs/operations/aws.md')}>
              AWS guide
            </a>
          </div>
          <div className="card host">
            <span className="kit-icon">
              <Icon name="shield" size={22} />
            </span>
            <h3>Hardened by default</h3>
            <ul className="tick-list">
              {HARDENING.map((h) => (
                <li key={h}>
                  <Icon name="check" size={16} />
                  <span>{h}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
      <p className="footnote">
        Apache-2.0. OCSO is pre-1.0: APIs, the schema and plugin contracts can still change.{' '}
        <a href={repo('README.md#status-and-known-gaps')}>Status and known gaps</a>.
      </p>
    </Section>
  );
}
