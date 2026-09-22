import Link from 'next/link';
import { KeyValue } from '@/components/ui/key-value';
import { requireSession } from '@/lib/session';

/** Deployment identity from the session (GET /v1/auth/me). */
export async function DeploymentCard() {
  const { user } = await requireSession();
  const d = user.deployment;
  return (
    <section className="ch" style={{ marginBottom: 14 }} aria-label="Deployment">
      <div className="t">
        <h3>Deployment</h3>
        <Link className="mono-sm" style={{ marginLeft: 'auto' }} href="/settings">
          settings →
        </Link>
      </div>
      <KeyValue
        items={[
          { k: 'organization', v: d.orgName },
          { k: 'label', v: d.label },
          { k: 'region', v: d.region ?? 'not set' },
          { k: 'timezone', v: d.timezone },
        ]}
      />
    </section>
  );
}
