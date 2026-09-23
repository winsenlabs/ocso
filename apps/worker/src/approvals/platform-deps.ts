import type { PlatformApprovalDeps } from '@ocso/application';
import { createAlertDeliveryRegistry, type OcsoPlugin } from '@ocso/bootstrap';
import type { ChannelRegistry } from '@ocso/channels';
import type { WorkerEnv } from '@ocso/config';
import type { EmailSender } from '@ocso/email';
import type { ProviderRegistry } from '@ocso/model-providers';
import type { SecretStore } from '@ocso/secrets';
import { CHANNEL_REGISTRY, EMAIL_SENDER, ENV, PLUGINS, PROVIDER_REGISTRY, SECRET_STORE } from '../infrastructure/tokens.js';

/**
 * What the platform approval descriptors need in the worker: validation at deferred activation, and the MCP
 * activation that re-contacts the server (PM/research/11 §4, COVERAGE-PLATFORM).
 */
export const PLATFORM_APPROVAL_DEPS = Symbol('PLATFORM_APPROVAL_DEPS');

/** Validation only: approval never delivers an alert from here. */
const noDelivery: typeof fetch = () => Promise.reject(new Error('alert delivery is not available while validating an approval'));

export const platformApprovalDepsProvider = {
  provide: PLATFORM_APPROVAL_DEPS,
  inject: [SECRET_STORE, CHANNEL_REGISTRY, PROVIDER_REGISTRY, PLUGINS, EMAIL_SENDER, ENV],
  useFactory: (secrets: SecretStore, channels: ChannelRegistry, providers: ProviderRegistry, plugins: readonly OcsoPlugin[], emailSender: EmailSender, env: WorkerEnv): PlatformApprovalDeps => ({
    secrets,
    validateChannel: (kind, settings, values) => (channels.has(kind) ? channels.get(kind).validateConfig(settings, values) : [`channel kind ${kind} is not available`]),
    providers,
    deliveries: createAlertDeliveryRegistry({ fetch: noDelivery, emailSender }, plugins),
    publicUrl: env.OCSO_PUBLIC_URL,
    mcp: {},
  }),
};
