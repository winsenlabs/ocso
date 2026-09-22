import type { AlertDeliveryAdapter, DestinationKind } from './contract.js';
import type { DeliveryAdapterDeps } from './adapters/deps.js';
import { nodemailerTransportFactory } from './adapters/email-transport.js';
import { createEmailAdapter } from './adapters/email.js';
import { createInAppAdapter } from './adapters/in-app.js';
import { createPagerDutyAdapter } from './adapters/pagerduty.js';
import { createSlackAdapter } from './adapters/slack.js';
import { createTeamsAdapter } from './adapters/teams.js';
import { createWebhookAdapter } from './adapters/webhook.js';

/** Delivery adapters are registered, never switched on (build rule §4). */
export class AlertDeliveryRegistry {
  private readonly adapters = new Map<DestinationKind, AlertDeliveryAdapter>();

  register(adapter: AlertDeliveryAdapter): this {
    if (this.adapters.has(adapter.kind)) throw new Error(`alert delivery adapter ${adapter.kind} already registered`);
    this.adapters.set(adapter.kind, adapter);
    return this;
  }

  get(kind: DestinationKind): AlertDeliveryAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`no alert delivery adapter registered for ${kind}`);
    return adapter;
  }

  find(kind: string): AlertDeliveryAdapter | undefined {
    return this.adapters.get(kind as DestinationKind);
  }

  has(kind: string): boolean {
    return this.adapters.has(kind as DestinationKind);
  }

  kinds(): DestinationKind[] {
    return [...this.adapters.keys()];
  }
}

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
