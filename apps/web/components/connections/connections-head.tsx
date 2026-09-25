import Link from 'next/link';
import { PageHead } from '@/components/ui/page-head';
import { requireSession } from '@/lib/session';
import { permittedTabs, permittedViews, primaryAction, resolveTab, resolveView } from './connection-tab';
import { connectionsHref, param } from './url';

export const PAGE_TITLE = 'Integrations';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Title, description and the one primary action of the Integrations section in the URL, for users who may use it. */
export async function ConnectionsHead({ searchParams }: { searchParams: SearchParams }) {
  const [session, params] = await Promise.all([requireSession(), searchParams]);
  const tab = resolveTab(param(params, 'tab'), permittedTabs(session));
  const section = permittedTabs(session).find((s) => s.key === tab);
  if (!section) return <PageHead title={PAGE_TITLE} />;
  const view = section.key === 'mcp' ? resolveView(param(params, 'view'), permittedViews(session)) : null;
  const action = primaryAction(section, session, view);
  return (
    <PageHead
      title={section.title}
      sub={section.sub}
      actions={
        action ? (
          <Link className="btn accent" href={connectionsHref({ tab: section.key, dialog: action.dialog })} scroll={false}>
            {action.label}
          </Link>
        ) : undefined
      }
    />
  );
}
