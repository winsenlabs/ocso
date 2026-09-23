import { ALERT_EVENTS, DESTINATION_KIND_PATTERN, describeDestinationKind, type AlertDeliveryAdapter, type AlertEvent, type DestinationKindInfo } from './contract.js';
import type { DeliveryAdapterDeps } from './adapters/deps.js';
import { nodemailerTransportFactory } from './adapters/email-transport.js';
import { createEmailAdapter } from './adapters/email.js';
import { createInAppAdapter } from './adapters/in-app.js';
import { createPagerDutyAdapter } from './adapters/pagerduty.js';
import { createSlackAdapter } from './adapters/slack.js';
import { createTeamsAdapter } from './adapters/teams.js';
import { createWebhookAdapter } from './adapters/webhook.js';

/**
 * Delivery adapters are registered, never switched on (build rule §4). The
 * registry is the only authority on which destination kinds exist, what each
 * one's form looks like and which lifecycle events it receives.
 */
export class AlertDeliveryRegistry {
  private readonly adapters = new Map<string, AlertDeliveryAdapter>();

  register(adapter: AlertDeliveryAdapter): this {
    if (!DESTINATION_KIND_PATTERN.test(adapter.kind)) throw new Error(`alert destination kind ${adapter.kind} must be upper snake case`);
    if (this.adapters.has(adapter.kind)) throw new Error(`alert delivery adapter ${adapter.kind} already registered`);
    if (!adapter.events.length || adapter.events.some((e) => !ALERT_EVENTS.includes(e))) {
      throw new Error(`alert delivery adapter ${adapter.kind} must receive known lifecycle events`);
    }
    this.adapters.set(adapter.kind, adapter);
    return this;
  }

  get(kind: string): AlertDeliveryAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`no alert delivery adapter registered for ${kind}`);
    return adapter;
  }

  find(kind: string): AlertDeliveryAdapter | undefined {
    return this.adapters.get(kind);
  }

  has(kind: string): boolean {
    return this.adapters.has(kind);
  }

  kinds(): string[] {
    return [...this.adapters.keys()];
  }

  /** True when destinations of `kind` receive `event`; unregistered kinds receive nothing. */
  receives(kind: string, event: AlertEvent): boolean {
    return this.adapters.get(kind)?.events.includes(event) ?? false;
  }

  /** Every registered kind as served by `GET /v1/notification-destinations/kinds`, in registration order. */
  describe(): DestinationKindInfo[] {
    return [...this.adapters.values()].map(describeDestinationKind);
  }
}

/** What alert dispatch needs from the registry: which kinds receive which lifecycle events. */
export type DestinationEventRouting = Pick<AlertDeliveryRegistry, 'receives'>;

export interface DefaultRegistryOptions extends Partial<DeliveryAdapterDeps> {
  fetch: DeliveryAdapterDeps['fetch'];
}

/** All built-in adapters. Production passes an SSRF-guarded fetch and the deployment email sender; tests pass fakes. */
export function createDefaultDeliveryRegistry(options: DefaultRegistryOptions): AlertDeliveryRegistry {
  const deps: DeliveryAdapterDeps = {
    fetch: options.fetch,
    mailTransport: options.mailTransport ?? nodemailerTransportFactory,
    emailSender: options.emailSender ?? null,
    timeoutMs: options.timeoutMs,
    now: options.now,
  };
  return new AlertDeliveryRegistry()
    .register(createInAppAdapter())
    .register(createEmailAdapter(deps))
    .register(createSlackAdapter(deps))
    .register(createTeamsAdapter(deps))
    .register(createWebhookAdapter(deps))
    .register(createPagerDutyAdapter(deps));
}
