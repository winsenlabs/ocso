import { Permission, can, type Principal } from '@ocso/auth';
import { forbidden } from '@ocso/domain';
import type { Db } from '@ocso/db';
import { QueueService } from '../routing/queues.js';
import { SettingsService } from '../settings/settings.js';
import type { QueueStatsSource } from '../telemetry/queue-depth.js';
import { adminHome, type AdminHome } from './home-admin.js';
import { execHome, type ExecHome } from './home-exec.js';
import { leadHome, type LeadHome } from './home-lead.js';
import { startOfDay } from './values.js';

export type HomeView =
  | { role: 'SERVICE'; generatedAt: string; user: { id: string; name: string }; exec: ExecHome }
  | { role: 'HEAD'; generatedAt: string; user: { id: string; name: string }; lead: LeadHome }
  | { role: 'TECH'; generatedAt: string; user: { id: string; name: string }; admin: AdminHome };

/**
 * Role-aware home (design/06, build rule §15). Each role receives exactly one
 * surface, gated by permission: execs never get technical telemetry, Tech
 * Admins never get conversation content (counts only).
 */
export class HomeService {
  constructor(
    private readonly db: Db,
    private readonly options: { queueStats?: QueueStatsSource | undefined } = {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  async home(principal: Principal): Promise<HomeView> {
    const now = this.now();
    const generatedAt = now.toISOString();
    const user = { id: principal.userId, name: principal.displayName };
    const { timezone } = await new SettingsService(this.db).deployment();
    if (principal.role === 'TECH' && can(principal, Permission.TELEMETRY_TECHNICAL_READ)) {
      const dayStart = await startOfDay(this.db, now, timezone);
      return { role: 'TECH', generatedAt, user, admin: await adminHome(this.db, now, dayStart, this.options.queueStats) };
    }
    // The lead home serves Heads and Leads alike.
    if ((principal.role === 'HEAD' || principal.role === 'LEAD') && can(principal, Permission.ANALYTICS_BUSINESS_READ)) {
      return { role: 'HEAD', generatedAt, user, lead: await leadHome(this.db, principal, now, timezone) };
    }
    if (principal.role === 'SERVICE' && can(principal, Permission.CONVERSATIONS_READ)) {
      const [dayStart, queueIds] = await Promise.all([startOfDay(this.db, now, timezone), new QueueService(this.db).queuesForTeams(principal.teamIds)]);
      return { role: 'SERVICE', generatedAt, user, exec: await execHome(this.db, principal, queueIds, now, dayStart) };
    }
    throw forbidden('home', `role ${principal.role} has no home surface`);
  }
}
