import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import { AgentAnalyticsService, AnalyticsQuery, QueueAnalyticsService, agentComparison } from '@ocso/application';
import type { Db } from '@ocso/db';
import { z } from 'zod';
import { CurrentPrincipal, RequirePermission } from '../../common/decorators.js';
import { DB } from '../../infrastructure/tokens.js';
import { escalationReasonsReport } from './escalation-reasons.report.js';

const Id = z.uuid();

/**
 * Lead business analytics (design/02 Overview + Analytics tabs, docs/11 §3).
 * Every metric carries its formula in `definition`; no composite quality score.
 */
@Controller('v1/analytics')
export class AnalyticsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AgentAnalyticsService) private readonly analytics: AgentAnalyticsService,
    @Inject(QueueAnalyticsService) private readonly queues: QueueAnalyticsService,
  ) {}

  /** Agent-by-agent comparison and escalation ranking ("which agent is escalating the most"). */
  @Get('agents')
  @RequirePermission(Permission.ANALYTICS_BUSINESS_READ)
  comparison(@CurrentPrincipal() principal: Principal, @Query({ schema: AnalyticsQuery }) q: AnalyticsQuery) {
    return agentComparison(this.db, principal, q.days);
  }

  @Get('agents/:id')
  @RequirePermission(Permission.ANALYTICS_BUSINESS_READ)
  agent(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string, @Query({ schema: AnalyticsQuery }) q: AnalyticsQuery) {
    return this.analytics.analytics(principal, id, q.days);
  }

  /** The same analytics aggregated over every virtual agent. */
  @Get('overview')
  @RequirePermission(Permission.ANALYTICS_BUSINESS_READ)
  overview(@CurrentPrincipal() principal: Principal, @Query({ schema: AnalyticsQuery }) q: AnalyticsQuery) {
    return this.analytics.analytics(principal, null, q.days);
  }

  @Get('queues')
  @RequirePermission(Permission.ANALYTICS_BUSINESS_READ)
  queueAnalytics(@CurrentPrincipal() principal: Principal, @Query({ schema: AnalyticsQuery }) q: AnalyticsQuery) {
    return this.queues.list(principal, q.days);
  }

  /** Escalation reasons ranked, vs the previous window, by agent/queue and per day (Escalation reasons page). */
  @Get('escalation-reasons')
  @RequirePermission(Permission.ANALYTICS_BUSINESS_READ)
  escalationReasons(@CurrentPrincipal() principal: Principal, @Query({ schema: AnalyticsQuery }) q: AnalyticsQuery) {
    return escalationReasonsReport(this.db, principal, q.days);
  }
}
