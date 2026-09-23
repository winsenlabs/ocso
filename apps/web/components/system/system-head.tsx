import { PageHead } from '@/components/ui/page-head';
import { requireSession } from '@/lib/session';

/** Page title with the deployment identity from the session (GET /v1/auth/me). */
export async function SystemHead({ title, tail }: { title: string; tail: string }) {
  const { user } = await requireSession();
  const d = user.deployment;
  return <PageHead title={title} sub={[d.orgName, 'single-tenant deployment', d.label, d.region ?? 'region not set', tail].join(' · ')} />;
}
