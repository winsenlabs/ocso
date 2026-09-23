/**
 * Pure Service member selection for AUTO_ASSIGN handoffs (docs/09 §3).
 * Eligibility is strict; ranking is deterministic so tests and audits can
 * explain every decision.
 */

export type ExecAvailability = 'AVAILABLE' | 'AWAY' | 'OFFLINE';

export interface ExecCandidate {
  userId: string;
  availability: ExecAvailability;
  activeConversations: number;
  maxConcurrent: number;
  teamIds: readonly string[];
  skills: readonly string[];
  languages: readonly string[];
  lastAssignedAt: Date | null;
}

export interface AssignmentRequest {
  /** Teams that serve the target queue. */
  queueTeamIds: readonly string[];
  requiredSkills: readonly string[];
  preferredLanguage?: string | undefined;
  /** Customer's account owner, preferred when eligible. */
  accountOwnerUserId?: string | undefined;
  /** Users who declined or timed out on this handoff. */
  excludeUserIds?: readonly string[] | undefined;
}

export type IneligibleReason =
  | 'not_available'
  | 'not_in_queue_team'
  | 'at_capacity'
  | 'missing_skill'
  | 'excluded';

export interface AssignmentDecision {
  userId: string;
  reasons: string[];
}

export function ineligibilityReason(
  c: ExecCandidate,
  req: AssignmentRequest,
): IneligibleReason | null {
  if (req.excludeUserIds?.includes(c.userId)) return 'excluded';
  if (c.availability !== 'AVAILABLE') return 'not_available';
  if (!c.teamIds.some((t) => req.queueTeamIds.includes(t))) return 'not_in_queue_team';
  if (c.activeConversations >= c.maxConcurrent) return 'at_capacity';
  if (!req.requiredSkills.every((s) => c.skills.includes(s))) return 'missing_skill';
  return null;
}

function speaks(c: ExecCandidate, lang: string | undefined): boolean {
  return !!lang && c.languages.some((l) => l.toLowerCase() === lang.toLowerCase());
}

/**
 * Ranking: account owner → language match → lowest load ratio →
 * fewest active → longest since last assignment → userId (stable tiebreak).
 */
export function selectAssignee(
  candidates: readonly ExecCandidate[],
  req: AssignmentRequest,
): AssignmentDecision | null {
  const eligible = candidates.filter((c) => ineligibilityReason(c, req) === null);
  if (eligible.length === 0) return null;

  const ranked = [...eligible].sort((a, b) => {
    const owner = Number(b.userId === req.accountOwnerUserId) - Number(a.userId === req.accountOwnerUserId);
    if (owner !== 0) return owner;
    const lang = Number(speaks(b, req.preferredLanguage)) - Number(speaks(a, req.preferredLanguage));
    if (lang !== 0) return lang;
    const load = a.activeConversations / a.maxConcurrent - b.activeConversations / b.maxConcurrent;
    if (load !== 0) return load;
    const active = a.activeConversations - b.activeConversations;
    if (active !== 0) return active;
    const idle = (a.lastAssignedAt?.getTime() ?? 0) - (b.lastAssignedAt?.getTime() ?? 0);
    if (idle !== 0) return idle;
    return a.userId.localeCompare(b.userId);
  });

  const winner = ranked[0]!;
  const reasons: string[] = [];
  if (winner.userId === req.accountOwnerUserId) reasons.push('account_owner');
  if (speaks(winner, req.preferredLanguage)) reasons.push('language_match');
  reasons.push(`load ${winner.activeConversations}/${winner.maxConcurrent}`);
  return { userId: winner.userId, reasons };
}
