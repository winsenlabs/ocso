import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Principal } from '@ocso/auth';
import { DomainError } from '@ocso/domain';
import type { CapabilityCall, CapabilityResponse, CapabilityRunner, DelegationScope } from '@ocso/internal-agent';
import { DelegationTokens } from '../../common/delegation.js';
import { OUTCOME_UNKNOWN_CODE, READ_TIMEOUT_MS, WRITE_TIMEOUT_MS } from './bounds.js';

export { CONFIRM_BOUND_MS, OUTCOME_UNKNOWN_CODE, READ_TIMEOUT_MS, WRITE_TIMEOUT_MS } from './bounds.js';

/**
 * Runs catalog routes in-process as the user (PM/research/12 §6): the API's own Express app, served on a
 * private listener bound to 127.0.0.1 on an ephemeral port — never a public hop — with a single-use delegation
 * token bound to the user's session, the thread, the card or call and the exact request. The auth guard accepts
 * such tokens only on this listener, so guards, validation, team scoping, approvals, rate limits and audit are
 * exactly the UI's. There is no service-account path: a principal without a session cannot delegate, except
 * through a linked chat account (Ask OCSO over Slack or Teams), whose token is bound to the link instead.
 */
@Injectable()
export class LoopbackCapabilityRunner implements CapabilityRunner, OnModuleDestroy {
  private server: Server | null = null;
  private port: Promise<number> | null = null;
  /** Per-call bounds (tests shorten them). */
  readTimeoutMs = READ_TIMEOUT_MS;
  writeTimeoutMs = WRITE_TIMEOUT_MS;

  constructor(
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
    @Inject(DelegationTokens) private readonly tokens: DelegationTokens,
  ) {}

  private listen(): Promise<number> {
    this.port ??= new Promise<number>((resolve, reject) => {
      const server = createServer(this.host.httpAdapter.getInstance());
      server.once('error', (err) => {
        this.port = null;
        reject(err);
      });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        this.tokens.setListenerPort(port);
        resolve(port);
      });
      this.server = server;
    });
    return this.port;
  }

  async call(principal: Principal, scope: DelegationScope, call: CapabilityCall): Promise<CapabilityResponse> {
    // A signed-in session (the drawer), or a linked chat account (a staff chat channel): never neither.
    const bound = principal.sessionId ? { sessionId: principal.sessionId } : principal.chatLink ? { linkId: principal.chatLink.linkId, surface: principal.chatLink.surface } : null;
    if (!bound) throw new DomainError('authentication', 'no_session', 'Ask OCSO acts only within a signed-in session or a linked chat account');
    const port = await this.listen();
    const url = new URL(call.path, `http://127.0.0.1:${port}`);
    for (const [key, value] of Object.entries(call.query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) for (const v of value) url.searchParams.append(key, String(v));
      else url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    const token = this.tokens.issue({
      userId: principal.userId,
      ...bound,
      threadId: scope.threadId,
      ...(scope.cardId ? { cardId: scope.cardId } : {}),
      ...(scope.callId ? { callId: scope.callId } : {}),
      method: call.method,
      path: url.pathname,
    });
    const hasBody = call.method !== 'GET' && call.body !== undefined;
    const write = call.method !== 'GET';
    const limitMs = write ? this.writeTimeoutMs : this.readTimeoutMs;
    const signal = AbortSignal.timeout(limitMs);
    let text: string;
    let res: Response;
    try {
      res = await fetch(url, {
        method: call.method,
        headers: { authorization: `Delegation ${token}`, 'x-correlation-id': scope.correlationId, ...(hasBody ? { 'content-type': 'application/json' } : {}) },
        ...(hasBody ? { body: JSON.stringify(call.body) } : {}),
        signal,
      });
      text = await res.text();
    } catch (err) {
      // The route keeps running after the abort and can still commit: a write is never reported as not done.
      if (write && signal.aborted) return outcomeUnknown(limitMs);
      throw err;
    }
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: res.status, body };
  }

  async onModuleDestroy(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    this.tokens.setListenerPort(null);
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * A write the route did not answer within its bound. The card's result says so honestly (the runtime settles
 * it with this message); `details.outcome` lets a runtime that knows the UNKNOWN card status use it.
 */
export function outcomeUnknown(limitMs: number): CapabilityResponse {
  const seconds = Math.round(limitMs / 1000);
  return {
    status: 504,
    body: {
      error: {
        category: 'timeout',
        code: OUTCOME_UNKNOWN_CODE,
        message: `OCSO did not finish this within ${seconds} seconds, so it may or may not have applied. Check the object in OCSO before asking again.`,
        details: { outcome: 'UNKNOWN' },
      },
    },
  };
}
