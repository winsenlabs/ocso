import { ROLE_PERMISSIONS, type Role } from '@ocso/auth';
import type { Capability } from '../catalog/index.js';

const ROLES = new Set(Object.keys(ROLE_PERMISSIONS));
const isRole = (v: unknown): v is Role => typeof v === 'string' && ROLES.has(v);
/** Every permission of `next` is also in `prev`: moving to it only takes rights away. */
const within = (next: Role, prev: Role) => [...ROLE_PERMISSIONS[next]].every((p) => ROLE_PERMISSIONS[prev].has(p));

/**
 * Whether a people change widens someone's rights, so the route will want a checker (PM/research/11 §3.4:
 * reductions apply at once, widening waits for approval). `current` is the user as the list route shows them
 * (role, status, teamIds). Predicting it lets the card ask for a checker up front instead of saying
 * "Applies now" and flipping to "Needs approval" on the click; the route's own answer still decides.
 */
export function widensRights(capability: Capability, body: Record<string, unknown> | undefined, current: Record<string, unknown> | null): boolean {
  if (capability.approvalKind !== 'permission_change' || !body) return false;
  if (capability.name === 'users.add_team_member') return true;
  const before = isRole(current?.['role']) ? current['role'] : null;
  const next = body['preset'] ?? body['role'];
  if (isRole(next) && before && next !== before && !within(next, before)) return true;
  const teams = Array.isArray(current?.['teamIds']) ? (current['teamIds'] as unknown[]) : null;
  if (Array.isArray(body['teamIds']) && teams && body['teamIds'].some((t) => !teams.includes(t))) return true;
  if (body['status'] === 'ACTIVE' && current?.['status'] !== undefined && current['status'] !== 'ACTIVE') return true;
  return Array.isArray(body['changes']) && body['changes'].some((op) => (op as { op?: unknown } | null)?.op === 'GRANT');
}
