import { createBuiltinToolSource } from '@ocso/agent-runtime';
import { createEmailAdapter, createInAppAdapter, createPagerDutyAdapter, createSlackAdapter, createTeamsAdapter, createWebhookAdapter } from '@ocso/alerts';
import { AUDIT_STORE_DRIVERS } from '@ocso/audit-store';
import { createMsTeamsAdapter, createSlackChannelAdapter, createTwilioWhatsAppAdapter, createWebChatAdapter, createWhatsAppAdapter } from '@ocso/channels';
import { EMAIL_DRIVERS } from '@ocso/email';
import { FIRST_PARTY_PROVIDERS } from '@ocso/model-providers';
import { connectionToolSource } from '@ocso/tools';
import {
  awsSecretsDriver,
  composeDeploymentDriver,
  ecsDeploymentDriver,
  localBlobDriver,
  localSecretsDriver,
  postgresQueueDriver,
  s3BlobDriver,
  sqsQueueDriver,
} from './drivers/first-party.js';
import type { OcsoPlugin } from './plugin.js';
import { MCP_TOOL_SOURCE, McpToolProviderFactory } from './tool-providers.js';

/**
 * The plugins compiled into this build, one per package. The api, the worker
 * and the seed build every registry from this list (the composition root);
 * a future plugin loader appends the configured external plugins to it.
 * Order matters where a list is shown: channels appear in the "Add channel"
 * list in this order (Twilio is the primary WhatsApp path, Meta Cloud API
 * the alternative).
 */
export const FIRST_PARTY_PLUGINS: readonly OcsoPlugin[] = [
  { name: '@ocso/channels', channels: [createTwilioWhatsAppAdapter, createWhatsAppAdapter, createWebChatAdapter, createSlackChannelAdapter, createMsTeamsAdapter] },
  { name: '@ocso/model-providers', modelProviders: FIRST_PARTY_PROVIDERS },
  {
    name: '@ocso/alerts',
    alertDestinations: [createInAppAdapter, createEmailAdapter, createSlackAdapter, createTeamsAdapter, createWebhookAdapter, createPagerDutyAdapter],
  },
  { name: '@ocso/agent-runtime', toolProviders: [({ db }) => createBuiltinToolSource(db)] },
  {
    name: '@ocso/mcp',
    toolProviders: [({ db, secrets, settings }) => connectionToolSource(MCP_TOOL_SOURCE, new McpToolProviderFactory(db, secrets, settings))],
  },
  { name: '@ocso/email', emailDrivers: EMAIL_DRIVERS },
  { name: '@ocso/blob', blobDrivers: [localBlobDriver, s3BlobDriver] },
  { name: '@ocso/secrets', secretsDrivers: [localSecretsDriver, awsSecretsDriver] },
  { name: '@ocso/queue', queueDrivers: [postgresQueueDriver, sqsQueueDriver] },
  { name: '@ocso/deployment', deploymentDrivers: [composeDeploymentDriver, ecsDeploymentDriver] },
  { name: '@ocso/audit-store', auditStoreDrivers: AUDIT_STORE_DRIVERS },
];
