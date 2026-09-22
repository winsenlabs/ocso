import { Permission } from '@ocso/auth';
import { getSession, hasPermission } from '@/lib/session';
import { TemplateNotices } from './template-notices';

/** Mounted once in the app frame: only people who submit templates listen for review results. */
export async function TemplateNoticesSlot() {
  const session = await getSession();
  if (!session || !hasPermission(session, Permission.MESSAGE_TEMPLATES_MANAGE)) return null;
  return <TemplateNotices meId={session.user.id} />;
}
