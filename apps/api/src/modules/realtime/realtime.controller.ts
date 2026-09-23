import { Controller, Inject, Query, Req, Sse, SseSignal, type MessageEvent } from '@nestjs/common';
import { Observable, from, interval, map, merge, mergeMap, of, takeUntil, fromEvent } from 'rxjs';
import { endsWhenSessionEnds } from '../../common/session-watch.js';
import type { Principal } from '@ocso/auth';
import { SessionLiveness, SettingsService } from '@ocso/application';
import type { ApiEnv } from '@ocso/config';
import type { Db } from '@ocso/db';
import { z } from 'zod';
import { Authenticated, CurrentPrincipal, type OcsoRequest } from '../../common/decorators.js';
import { DB, ENV } from '../../infrastructure/tokens.js';
import { RealtimeAccess } from './realtime-access.js';
import { RealtimeHub } from './realtime.hub.js';

const StreamQuery = z.object({
  conversationId: z.uuid().optional(),
  /** Only these event types (comma list), filtered before access checks — cheap app-wide listeners. */
  types: z
    .string()
    .max(2_000)
    .optional()
    .transform((v) => (v ? new Set(v.split(',').filter(Boolean)) : null)),
});
type StreamQuery = z.infer<typeof StreamQuery>;

/**
 * Staff realtime stream (docs/14 §3). Conversation events reach only users who
 * may access that conversation (the same conversationScope as the inbox — no
 * role bypasses it, ADR-026); alert and config events follow alert audiences
 * and, when they concern an agent, whether the user can read that agent.
 */
@Controller('v1/realtime')
export class RealtimeController {
  constructor(
    @Inject(RealtimeHub) private readonly hub: RealtimeHub,
    @Inject(DB) private readonly db: Db,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(SessionLiveness) private readonly liveness: SessionLiveness,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  @Sse('stream')
  @Authenticated()
  stream(@CurrentPrincipal() principal: Principal, @Query({ schema: StreamQuery }) q: StreamQuery, @SseSignal() signal: AbortSignal, @Req() req: OcsoRequest): Observable<MessageEvent> {
    const access = new RealtimeAccess(this.db, this.settings, principal);
    const events = this.hub
      .stream((e) => (q.conversationId ? e.conversationId === q.conversationId : true) && (q.types ? q.types.has(e.type) : true))
      .pipe(
        mergeMap((event) => from(access.allows(event)).pipe(mergeMap((ok) => (ok ? of(event) : [])))),
        map((event): MessageEvent => ({ type: event.type, id: event.id, data: event })),
      );
    const keepalive = interval(20_000).pipe(map((): MessageEvent => ({ type: 'ping', data: {} })));
    // The session is re-checked every SESSION_STREAM_RECHECK_SECONDS: revoked, expired, idle,
    // disabled user or unmet MFA policy ends the stream (ADR-025); the client's reconnect then gets 401.
    const sessionEnded = endsWhenSessionEnds(this.liveness, req.authSession?.id, this.env.SESSION_STREAM_RECHECK_SECONDS * 1000, principal);
    return merge(of<MessageEvent>({ type: 'ready', data: { at: new Date().toISOString() } }), events, keepalive).pipe(
      takeUntil(merge(fromEvent(signal, 'abort'), sessionEnded)),
    );
  }
}
