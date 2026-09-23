import type { AlertDeliveryRegistry } from '@ocso/alerts';
import type { DnsResolver, EgressLimits } from '@ocso/mcp';
import type { ProviderRegistry } from '@ocso/model-providers';
import type { SecretStore } from '@ocso/secrets';
import { destinationApproval } from '../alerts/destination-approval.js';
import type { ApprovalDescriptor } from '../approvals/contract.js';
import { channelApproval } from '../channels/channel-approval.js';
import type { ChannelConfigValidator } from '../channels/channels.js';
import { ssoProviderApproval } from '../identity/auth/sso-approval.js';
import { connectionApproval } from '../mcp/connection-approval.js';
import { pricingApproval } from '../models/pricing-approval.js';
import { profileApproval } from '../models/profile-approval.js';
import { providerApproval } from '../models/provider-approval.js';
import { webhookApproval } from '../webhooks/webhook-approval.js';
import { settingsApproval } from './settings-approval.js';

/**
 * What the platform descriptors need from the process that builds the approval registry (the API and the
 * worker pass them through `createApprovalRegistry({ platform })`). Every field is optional: a process that
 * lacks one still registers every kind, and a check that needs the missing piece reports a validation problem
 * (so nothing is approved unchecked) instead of passing.
 */
export interface PlatformApprovalDeps {
  secrets?: SecretStore | undefined;
  /** The channel registry's settings/secrets validation. */
  validateChannel?: ChannelConfigValidator | undefined;
  providers?: ProviderRegistry | undefined;
  deliveries?: AlertDeliveryRegistry | undefined;
  /** OCSO_PUBLIC_URL, for SSO callback URLs in the checker's view. */
  publicUrl?: string | undefined;
  /** MCP activation re-contacts the server (worker). */
  mcp?: { resolver?: DnsResolver | undefined; limits?: Partial<EgressLimits> | undefined; discoveryTimeoutMs?: number | undefined } | undefined;
}

/** The platform kinds (PM/research/11 §4, wave 2 COVERAGE-PLATFORM), for approvals/composition.ts. */
export function platformApprovals(deps: PlatformApprovalDeps = {}): ApprovalDescriptor[] {
  return [
    channelApproval({ secrets: deps.secrets, validateChannel: deps.validateChannel }),
    providerApproval({ secrets: deps.secrets, providers: deps.providers }),
    profileApproval({ providers: deps.providers }),
    pricingApproval,
    connectionApproval({ secrets: deps.secrets, ...deps.mcp }),
    destinationApproval({ secrets: deps.secrets, deliveries: deps.deliveries }),
    webhookApproval({ secrets: deps.secrets }),
    ssoProviderApproval({ publicUrl: deps.publicUrl }),
    settingsApproval,
  ];
}

/** The platform kinds' names, as the coverage test pins them. */
export const PLATFORM_APPROVAL_KINDS = [
  'channel',
  'model_provider',
  'model_profile',
  'model_pricing',
  'mcp_connection',
  'notification_destination',
  'webhook_subscription',
  'sso_provider',
  'deployment_settings',
] as const;
