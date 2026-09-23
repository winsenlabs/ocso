/**
 * Owning teams of a virtual agent (ADR-026), mirrored from the API rules so
 * the form only offers what the API accepts. The API remains the enforcement
 * point. Client-safe.
 *
 * - Tech admin (agents.assign_owner): any teams.
 * - Lead (agents.manage): add or remove only teams they belong to; other
 *   teams' ownership is shown but locked. Removing every one of their own
 *   teams hands the agent off (allowed while another team still owns it).
 * - Always at least one owning team.
 */

export type OwnerMode = 'admin' | 'lead';

export interface TeamRef {
  id: string;
  name: string;
}

export interface OwnerChoice {
  id: string;
  name: string;
  checked: boolean;
  /** Shown but not changeable by this user. */
  locked: boolean;
}

const byName = (a: TeamRef, b: TeamRef) => a.name.localeCompare(b.name);

/** Checkbox rows: every team for the admin; the lead's own teams plus locked foreign owners for a lead. */
export function ownerChoices(mode: OwnerMode, allTeams: readonly TeamRef[], owners: readonly TeamRef[], myTeamIds: readonly string[]): OwnerChoice[] {
  const owned = new Set(owners.map((t) => t.id));
  if (mode === 'admin') return [...allTeams].sort(byName).map((t) => ({ id: t.id, name: t.name, checked: owned.has(t.id), locked: false }));
  const mine = new Set(myTeamIds);
  const names = new Map([...allTeams, ...owners].map((t) => [t.id, t.name]));
  const rows = [...new Set([...myTeamIds, ...owners.map((t) => t.id)])].map((id) => ({ id, name: names.get(id) ?? 'Unknown team' }));
  return rows.sort(byName).map((t) => ({ id: t.id, name: t.name, checked: owned.has(t.id), locked: !mine.has(t.id) }));
}

/** Why a selection cannot be saved, or null. */
export function ownerProblem(selected: readonly string[]): string | null {
  return selected.length ? null : 'Choose at least one owning team.';
}

/** Warning when a lead's selection removes every team of theirs: they will lose access. */
export function handOffWarning(mode: OwnerMode, selected: readonly string[], myTeamIds: readonly string[]): string | null {
  if (mode !== 'lead' || !selected.length) return null;
  return selected.some((id) => myTeamIds.includes(id)) ? null : 'None of your teams will own this agent: you will lose access to it after saving.';
}

/** "Cards · Loans", or a fallback when unowned. */
export function ownerLabel(owners: readonly TeamRef[], none = 'no owning team'): string {
  return owners.length ? owners.map((t) => t.name).join(' · ') : none;
}

/** Teams a lead may choose when creating an agent: the teams they belong to. */
export function creatableTeams(allTeams: readonly TeamRef[], myTeamIds: readonly string[]): TeamRef[] {
  return allTeams.filter((t) => myTeamIds.includes(t.id)).sort(byName);
}
