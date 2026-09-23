import { Permission, can, effectivePermissions, type Principal } from '@ocso/auth';
import { forbidden } from '@ocso/domain';
import type { Db } from '@ocso/db';
import type { ApprovalRegistry } from '../approvals/registry.js';
import type { ExceptionReportContent } from '../exceptions/contract.js';
import { QueueService } from '../routing/queues.js';
import { SettingsService } from '../settings/settings.js';
import type { QueueStatsSource } from '../telemetry/queue-depth.js';
import { adminHome, type AdminHome } from './home-admin.js';
import { execHome, type ExecHome, type PickupItem } from './home-exec.js';
import { homeFlow, publicFlow, type HomeFlow } from './home-flow.js';
import { leadHomeWithTrend, type LeadHome } from './home-lead.js';
import { needsYou, type NeedsYouItem } from './home-needs-you.js';
import { homeSetup, type HomeSetup } from './home-setup.js';
import { leadTiles, servicePrevious, serviceTiles, techTiles, type HomeTile } from './home-tiles.js';
import { startOfDay } from './values.js';

/** Service extras (HOME decision 3): "take next", my shift and my queue (the exec surface's own data). */
export interface HomeServiceSection {
  /** Take next can claim something right now: I may claim, I have room under my concurrency limit, and an unassigned conversation waits in my queues. */
  nextAvailable: boolean;
  /** What take next would claim (POST /v1/conversations/:id/claim); null when nothing waits. */
  next: Pick<PickupItem, 'conversationId' | 'displayId' | 'customerName' | 'priority' | 'waitingSince' | 'slaDueAt'> | null;
  myShift: ExecHome['shift'];
  myQueue: PickupItem[];
}

interface HomeCommon {
  generatedAt: string;
  user: { id: string; name: string };
  /** Ranked (severity, then due/age), at most 20, only what this person may act on. */
  needsYou: NeedsYouItem[];
  tiles: HomeTile[];
}

export type HomeView =
  | (HomeCommon & { role: 'SERVICE'; exec: ExecHome; service: HomeServiceSection })
  | (HomeCommon & { role: 'HEAD'; lead: LeadHome; flow: HomeFlow; setup: HomeSetup })
  | (HomeCommon & { role: 'TECH'; admin: AdminHome; flow: HomeFlow; setup: HomeSetup });

export interface HomeServiceOptions {
  queueStats?: QueueStatsSource | undefined;
  /** The approval registry: which check permission decides each proposal kind. Without it any check permission counts. */
  registry?: ApprovalRegistry | undefined;
  /** The exception report's live view for a reader (ExceptionService.live); without it Home lists no exceptions. */
  liveExceptions?: ((principal: Principal) => Promise<{ content: ExceptionReportContent }>) | undefined;
  /** Per-user cache lifetime (default 15 s; 0 disables). */
  cacheMs?: number | undefined;
  /** A "needs you" source that failed (the others still show). */
  onError?: ((source: string, err: unknown) => void) | undefined;
}

export const HOME_CACHE_MS = 15_000;
const CACHE_MAX_ENTRIES = 1_000;

/**
 * Role-aware home (design/06, HOME contract). Each role receives exactly one
 * surface, gated by permission: execs never get technical telemetry, Tech
 * admins never get conversation content (counts only). Every surface also
 * carries one ranked "needs you" list and trend tiles; Heads, Leads and Tech
 * get the live service flow and the setup checklist; Service gets take next.
 * One request, parallel reads, cached per user for 15 s.
 */
export class HomeService {
  private readonly cache = new Map<string, { expires: number; value: Promise<HomeView> }>();

  constructor(
    private readonly db: Db,
    private readonly options: HomeServiceOptions = {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** `fresh` skips the cache (Cache-Control: no-cache), e.g. right after the user acted. */
  async home(principal: Principal, opts: { fresh?: boolean } = {}): Promise<HomeView> {
    const ttl = this.options.cacheMs ?? HOME_CACHE_MS;
    if (ttl <= 0) return this.compute(principal);
    const key = cacheKey(principal);
    const at = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expires > at && !opts.fresh) return hit.value;
    const value = this.compute(principal);
    this.cache.set(key, { expires: at + ttl, value });
    // A failed read is never served from the cache.
    value.catch(() => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
    });
    if (this.cache.size > CACHE_MAX_ENTRIES) this.evict(at);
    return value;
  }

  private evict(at: number): void {
    for (const [k, v] of this.cache) if (v.expires <= at) this.cache.delete(k);
    // Still full of live entries: drop the oldest inserted.
    while (this.cache.size > CACHE_MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
  }

  private async compute(principal: Principal): Promise<HomeView> {
    const now = this.now();
    const generatedAt = now.toISOString();
    const user = { id: principal.userId, name: principal.displayName };
    const settings = await new SettingsService(this.db).deployment();
    const { timezone } = settings;
    const policy = { execsCanViewAiActive: settings.execsCanViewAiActive };
    const askOcsoConfigured = settings.internalAgentProfileId !== null;
    const needs = (queueIds: readonly string[], flow: HomeFlow | null | Promise<HomeFlow>, setup: HomeSetup | null | Promise<HomeSetup>) =>
      needsYou(this.db, {
        principal,
        now,
        queueIds,
        flow,
        setup,
        approvalAgeWarningHours: settings.approvalAgeWarningHours,
        registry: this.options.registry,
        liveExceptions: this.options.liveExceptions,
        onError: this.options.onError,
      });

    if (principal.role === 'TECH' && can(principal, Permission.TELEMETRY_TECHNICAL_READ)) {
      const dayStart = await startOfDay(this.db, now, timezone);
      const flowP = homeFlow(this.db, principal, now, policy);
      const setupP = homeSetup(this.db, askOcsoConfigured);
      const [admin, flow, setup, trend, items] = await Promise.all([
        adminHome(this.db, now, dayStart, this.options.queueStats),
        flowP,
        setupP,
        techTiles(this.db, now),
        needs([], flowP, setupP),
      ]);
      const tiles: HomeTile[] = [
        ...trend,
        { key: 'open_incidents', label: 'Open incidents', value: admin.tiles.openIncidents, unit: 'count', previous: null, betterWhen: 'down', period: 'now', href: '/alerts?kind=technical' },
      ];
      return { role: 'TECH', generatedAt, user, needsYou: items, tiles, admin, flow: publicFlow(flow), setup };
    }
    // The lead home serves Heads and Leads alike.
    if ((principal.role === 'HEAD' || principal.role === 'LEAD') && can(principal, Permission.ANALYTICS_BUSINESS_READ)) {
      const queueIds = await new QueueService(this.db).queuesForTeams(principal.teamIds);
      const flowP = homeFlow(this.db, principal, now, policy);
      const setupP = homeSetup(this.db, askOcsoConfigured);
      const [{ lead, previous }, flow, setup, items] = await Promise.all([
        leadHomeWithTrend(this.db, principal, now, timezone),
        flowP,
        setupP,
        needs(queueIds, flowP, setupP),
      ]);
      return { role: 'HEAD', generatedAt, user, needsYou: items, tiles: leadTiles(lead, previous), lead, flow: publicFlow(flow), setup };
    }
    if (principal.role === 'SERVICE' && can(principal, Permission.CONVERSATIONS_READ)) {
      const [dayStart, yesterdayStart, queueIds] = await Promise.all([
        startOfDay(this.db, now, timezone),
        startOfDay(this.db, new Date(now.getTime() - 86_400_000), timezone),
        new QueueService(this.db).queuesForTeams(principal.teamIds),
      ]);
      const [exec, items, previous] = await Promise.all([
        execHome(this.db, principal, queueIds, now, dayStart),
        needs(queueIds, null, null),
        servicePrevious(this.db, principal.userId, now, dayStart, yesterdayStart),
      ]);
      return { role: 'SERVICE', generatedAt, user, needsYou: items, tiles: serviceTiles(exec, previous), exec, service: serviceSection(principal, exec) };
    }
    throw forbidden('home', `role ${principal.role} has no home surface`);
  }
}

function serviceSection(principal: Principal, exec: ExecHome): HomeServiceSection {
  const next = exec.pickupQueue.find((p) => p.offeredToUserId === null) ?? null;
  const room = exec.shift.maxConcurrent <= 0 || exec.shift.activeConversations < exec.shift.maxConcurrent;
  return {
    nextAvailable: Boolean(next) && room && can(principal, Permission.CONVERSATIONS_CLAIM),
    next: next ? { conversationId: next.conversationId, displayId: next.displayId, customerName: next.customerName, priority: next.priority, waitingSince: next.waitingSince, slaDueAt: next.slaDueAt } : null,
    myShift: exec.shift,
    myQueue: exec.pickupQueue,
  };
}

/** Everything that changes what a person may see: a new grant, team or role is a new entry. */
function cacheKey(p: Principal): string {
  return [p.userId, p.role, [...p.teamIds].sort().join(','), [...effectivePermissions(p)].sort().join(',')].join('|');
}
