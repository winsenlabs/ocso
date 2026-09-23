import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { Observable, Subject, filter } from 'rxjs';
import { EVENTS_CHANNEL } from '@ocso/application';
import { PgListener } from '@ocso/bootstrap';
import type { ApiEnv } from '@ocso/config';
import type { OcsoEvent } from '@ocso/events';
import { PinoLogger } from 'nestjs-pino';
import { ENV } from '../../infrastructure/tokens.js';

/**
 * One LISTEN connection per API instance fans committed domain events and
 * ephemeral stream events out to SSE subscribers (ADR-009). Subscribers apply
 * their own authorization filter per event.
 */
@Injectable()
export class RealtimeHub implements OnModuleInit, OnApplicationShutdown {
  private readonly events = new Subject<OcsoEvent>();
  private listener: PgListener | null = null;

  constructor(
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  async onModuleInit(): Promise<void> {
    this.listener = new PgListener(this.env.DATABASE_URL, (err) => this.logger.warn({ err }, 'realtime listener error'));
    this.listener.on((channel, payload) => {
      if (channel !== EVENTS_CHANNEL) return;
      try {
        this.events.next(JSON.parse(payload) as OcsoEvent);
      } catch {
        // malformed payloads are ignored
      }
    });
    await this.listener.start([EVENTS_CHANNEL]);
  }

  async onApplicationShutdown(): Promise<void> {
    this.events.complete();
    await this.listener?.stop();
  }

  stream(predicate: (event: OcsoEvent) => boolean): Observable<OcsoEvent> {
    return this.events.pipe(filter(predicate));
  }
}
