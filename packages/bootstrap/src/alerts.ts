import { AlertDeliveryRegistry, nodemailerTransportFactory, type DeliveryAdapterDeps } from '@ocso/alerts';
import { FIRST_PARTY_PLUGINS } from './first-party.js';
import { contributions, type OcsoPlugin } from './plugin.js';

/** What the host provides alert adapters; the SMTP transport defaults to nodemailer. */
export type AlertDeliveryHostDeps = Pick<DeliveryAdapterDeps, 'fetch'> & Partial<DeliveryAdapterDeps>;

/**
 * Alert delivery adapters of this deployment (registry, no switch): every
 * plugin's `alertDestinations`. Production passes the SSRF-guarded egress
 * fetch and the deployment email sender; tests pass fakes.
 */
export function createAlertDeliveryRegistry(deps: AlertDeliveryHostDeps, plugins: readonly OcsoPlugin[] = FIRST_PARTY_PLUGINS): AlertDeliveryRegistry {
  const adapterDeps: DeliveryAdapterDeps = {
    fetch: deps.fetch,
    mailTransport: deps.mailTransport ?? nodemailerTransportFactory,
    emailSender: deps.emailSender ?? null,
    timeoutMs: deps.timeoutMs,
    now: deps.now,
  };
  const registry = new AlertDeliveryRegistry();
  for (const create of contributions(plugins, 'alertDestinations')) registry.register(create(adapterDeps));
  return registry;
}
