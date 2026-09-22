import { Controller, Inject, Query, Sse, SseSignal, type MessageEvent } from '@nestjs/common';
import { Observable, from, interval, map, merge, mergeMap, of, takeUntil, fromEvent } from 'rxjs';
import { Permission, can, type Principal } from '@ocso/auth';
import { SettingsService, assertConversationAccess } from '@ocso/application';
import type { Db } from '@ocso/db';
import type { OcsoEvent } from '@ocso/events';
import { z } from 'zod';
import { Authenticated, CurrentPrincipal } from '../../common/decorators.js';
import { DB } from '../../infrastructure/tokens.js';
import { RealtimeHub } from './realtime.hub.js';

const StreamQuery = z.object({ conversationId: z.uuid().optional() });
type StreamQuery = z.infer<typeof StreamQuery>;

const ALERT_TYPES = new Set(['alert.opened', 'alert.updated', 'alert.resolved']);

/**
 * Staff realtime stream (docs/14 §3). Conversation events reach only users who
 * may access that conversation; alert events follow alert audiences.
 */
@Controller('v1/realtime')
export class RealtimeController {
  constructor(
    @Inject(RealtimeHub) private readonly hub: RealtimeHub,
    @Inject(DB) private readonly db: Db,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  @Sse('stream')
  @Authenticated()
  stream(@CurrentPrincipal() principal: Principal, @Query({ schema: StreamQuery }) q: StreamQuery, @SseSignal() signal: AbortSignal): Observable<MessageEvent> {
    const access = new AccessCache(this.db, this.settings, principal);
    const events = this.hub
      .stream((e) => (q.conversationId ? e.conversationId === q.conversationId : true))
      .pipe(
        mergeMap((event) => from(access.allows(event)).pipe(mergeMap((ok) => (ok ? of(event) : [])))),
        map((event): MessageEvent => ({ type: event.type, id: event.id, data: event })),
      );
    const keepalive = interval(20_000).pipe(map((): MessageEvent => ({ type: 'ping', data: {} })));
    return merge(of<MessageEvent>({ type: 'ready', data: { at: new Date().toISOString() } }), events, keepalive).pipe(
      takeUntil(fromEvent(signal, 'abort')),
    );
  }
}

/** Per-connection authorization cache (30 s) so SSE fan-out stays cheap. */
class AccessCache {
  private readonly decisions = new Map<string, { ok: boolean; at: number }>();

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly principal: Principal,
  ) {}

  async allows(event: OcsoEvent): Promise<boolean> {
    if (ALERT_TYPES.has(event.type)) {
      const kind = (event.payload as { kind?: string }).kind;
      if (kind === 'TECHNICAL') return can(this.principal, Permission.ALERTS_TECHNICAL_READ);
      if (kind === 'BUSINESS') return can(this.principal, Permission.ALERTS_BUSINESS_READ);
      // updated/resolved carry only the id; clients refetch through the audience-scoped GET.
      return can(this.principal, Permission.ALERTS_BUSINESS_READ) || can(this.principal, Permission.ALERTS_TECHNICAL_READ);
    }
    if (!event.conversationId) return event.type === 'config.changed' || event.type === 'cache.invalidated' ? can(this.principal, Permission.SYSTEM_READ) || can(this.principal, Permission.AGENTS_MANAGE) : false;
    if (can(this.principal, Permission.CONVERSATIONS_READ_ALL)) return true;
    if (!can(this.principal, Permission.CONVERSATIONS_READ)) return false;
    const cached = this.decisions.get(event.conversationId);
    if (cached && Date.now() - cached.at < 30_000) return cached.ok;
    let ok = true;
    try {
      const policy = await this.settings.deployment();
      await assertConversationAccess(this.db, this.principal, event.conversationId, { execsCanViewAiActive: policy.execsCanViewAiActive });
    } catch {
      ok = false;
    }
    this.decisions.set(event.conversationId, { ok, at: Date.now() });
    return ok;
  }
}
