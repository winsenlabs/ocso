import { ROLE_LABELS } from '@ocso/auth';
import { RoutedDrawer } from '@/components/quality/routed-drawer';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusChip } from '@/components/ui/status-chip';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { ApiError } from '@/lib/api/errors';
import { getPermissionCatalogue, getUserPermissions, type CatalogueEntry, type UserPermissions } from '@/lib/api/permissions';
import type { User } from '@/lib/api/users';
import { formatDateTime } from '@/lib/format';
import { PendingBadge } from '@/components/approvals/pending-badge';
import type { ObjectApprovalState } from '@/components/approvals/lib/schemas';
import { objectApprovalState } from '@/lib/api/approvals';
import { ChangePermissions } from './change-permissions';
import { DiscardPendingUser } from './discard-pending';
import { SubmitPendingUser } from './submit-pending';
import { ROLE_TONE, STATUS_CHIP } from './labels';
import { PermissionsPanel } from './permissions-panel';
import { ChatLinksCard } from '@/components/chat-links/chat-links-card';
import type { ChatLink } from '@/lib/api/chat-links';

export type UserDrawerTab = 'overview' | 'permissions';

export interface UserDrawerData {
  permissions: UserPermissions | null;
  catalogue: CatalogueEntry[];
  /** Maker–checker state of the person's creation or access change (PM/research/11 §3.4); null when not visible. */
  approval?: ObjectApprovalState | null;
  /** Chat accounts linked to Ask OCSO (Slack, Teams): loaded for a viewer with users.manage only; null = not shown. */
  chatLinks?: ChatLink[] | null;
}

/** The proposal waiting on this person (their creation, or an access change), for the drawer's badge. */
export async function loadUserApproval(userId: string): Promise<ObjectApprovalState | null> {
  const [user, change] = await Promise.all([objectApprovalState('user', userId).catch(() => null), objectApprovalState('permission_change', userId).catch(() => null)]);
  return user?.pending ? user : (change ?? user);
}

/** GET /v1/users/:id/permissions + the catalogue; out of scope (404/403) becomes "not visible". */
export async function loadUserDrawer(userId: string, canRead: boolean, canChange: boolean): Promise<UserDrawerData> {
  if (!canRead) return { permissions: null, catalogue: [] };
  try {
    const [permissions, catalogue] = await Promise.all([getUserPermissions(userId), canChange ? getPermissionCatalogue() : Promise.resolve([])]);
    return { permissions, catalogue };
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.isForbidden)) return { permissions: null, catalogue: [] };
    throw err;
  }
}

export interface UserDrawerProps {
  user: User | null;
  tab: UserDrawerTab;
  data: UserDrawerData;
  teamNames: string[];
  timeZone: string;
  viewer: { id: string; canReadPermissions: boolean; canChangePermissions: boolean; canManageUsers?: boolean };
}

/** User drawer (`/team?user=…`): who they are, and their effective permissions with sources (PM/research/11 §3.6). */
export function UserDrawer({ user, tab, data, teamNames, timeZone, viewer }: UserDrawerProps) {
  if (!user) {
    return (
      <RoutedDrawer title="User" sub="not available" closeHref="/team">
        <EmptyState title="User not available">This user does not exist.</EmptyState>
      </RoutedDrawer>
    );
  }
  const base = `/team?user=${user.id}`;
  const items = [{ key: 'overview', label: 'Overview', href: base }, ...(viewer.canReadPermissions ? [{ key: 'permissions', label: 'Permissions', href: `${base}&tab=permissions` }] : [])];
  const active = tab === 'permissions' && viewer.canReadPermissions ? 'permissions' : 'overview';
  const status = STATUS_CHIP[user.status];

  return (
    <RoutedDrawer title={user.name} sub={`${user.email} · ${ROLE_LABELS[user.role]}`} closeHref="/team">
      <div className="tm-user">
        <Tabs items={items} active={active} label={`About ${user.name}`} idBase="user-drawer" />
        <TabPanel idBase="user-drawer" active={active}>
          {active === 'overview' ? (
            <section className="tm-sec" aria-label="Overview">
              <span className="tm-chips">
                <StatusChip tone={ROLE_TONE[user.role]}>{ROLE_LABELS[user.role]}</StatusChip>
                <StatusChip tone={status.tone}>{status.label}</StatusChip>
              </span>
              {data.approval?.pending ? <PendingBadge state={data.approval} /> : null}
              {user.status === 'PENDING_APPROVAL' ? (
                <>
                  <p className="tm-desc">
                    {data.approval?.pending
                      ? 'Waiting for the checker: this user cannot sign in until their creation is approved. The invite is sent then.'
                      : 'Not submitted yet: this user cannot sign in until a checker approves their creation. Submit it, or discard the draft.'}
                  </p>
                  {viewer.canManageUsers ? (
                    <span className="tm-perm-actions">
                      {data.approval?.pending ? null : <SubmitPendingUser userId={user.id} name={user.name} role={ROLE_LABELS[user.role]} />}
                      <DiscardPendingUser userId={user.id} name={user.name} />
                    </span>
                  ) : null}
                </>
              ) : null}
              <p className="mono-sm">teams · {teamNames.length ? teamNames.join(', ') : 'none'}</p>
              <p className="mono-sm">last sign-in · {user.lastLoginAt ? formatDateTime(user.lastLoginAt, timeZone) : 'never'}</p>
              {data.chatLinks ? <ChatLinksCard links={data.chatLinks} timeZone={timeZone} whose={{ name: user.name }} /> : null}
            </section>
          ) : data.permissions ? (
            <>
              {viewer.canChangePermissions && user.id !== viewer.id ? (
                <ChangePermissions
                  user={{ id: user.id, name: user.name, role: data.permissions.preset, status: data.permissions.status, teamIds: user.teamIds }}
                  overrides={data.permissions.overrides.map((o) => ({ permission: o.permission, effect: o.effect, expiresAt: o.expiresAt }))}
                  catalogue={data.catalogue.map((c) => ({ permission: c.permission, label: c.label, group: c.group }))}
                />
              ) : user.id === viewer.id ? (
                <p className="mono-sm">Your own access is changed by a colleague, never by you.</p>
              ) : null}
              <PermissionsPanel view={data.permissions} timeZone={timeZone} />
            </>
          ) : (
            <EmptyState size="sm" title="Permissions not visible">
              You see the permissions of colleagues who share a team with you.
            </EmptyState>
          )}
        </TabPanel>
      </div>
    </RoutedDrawer>
  );
}
