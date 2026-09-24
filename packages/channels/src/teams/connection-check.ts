import type { ConnectionCheck, ConnectionCheckResult } from '../contract/types.js';
import type { ResolvedTeamsConfig } from './config.js';
import { SigningKeysUnavailableError, type BotFrameworkKeyStore } from './signing-keys.js';
import type { TeamsTokenClient } from './token-client.js';

/**
 * Read-only "Test" for a Microsoft Teams channel: a fresh client-credentials
 * token proves the app ID, client secret and tenant (Microsoft Entra names
 * the problem, e.g. AADSTS7000215 for a wrong secret); the Bot Framework
 * signing keys must be reachable, or no inbound message can be verified; and
 * the messaging endpoint must be public https for Azure Bot Service to call
 * it. Never sends a message: a bot cannot check a conversation without one.
 */

async function tokenCheck(config: ResolvedTeamsConfig, tokens: TeamsTokenClient): Promise<ConnectionCheck> {
  const name = 'App credentials';
  const result = await tokens.token(config, { fresh: true });
  if (!result.ok) return { name, ok: false, detail: result.message };
  const authority = config.settings.appType === 'SingleTenant' ? `tenant ${config.settings.tenantId}` : 'multi-tenant';
  return { name, ok: true, detail: `Microsoft Entra issued a Bot Connector token for app ${config.settings.appId} (${authority})` };
}

async function keysCheck(config: ResolvedTeamsConfig, keys: BotFrameworkKeyStore): Promise<ConnectionCheck> {
  const name = 'Signing keys';
  try {
    const count = await keys.count(config.endpoints.openIdMetadataUrl);
    return { name, ok: true, detail: `${count} Bot Framework signing key${count === 1 ? '' : 's'} published; inbound messages can be verified` };
  } catch (error) {
    return { name, ok: false, detail: error instanceof SigningKeysUnavailableError ? error.message : 'Bot Framework signing keys unavailable' };
  }
}

function endpointCheck(webhookUrl: string | undefined): ConnectionCheck {
  const name = 'Messaging endpoint';
  if (webhookUrl?.startsWith('https://')) return { name, ok: true, detail: 'set the Azure Bot’s messaging endpoint to this channel’s https webhook' };
  return { name, ok: false, detail: 'Azure Bot Service only calls public https endpoints: set OCSO_PUBLIC_URL to the https origin Microsoft can reach' };
}

export async function checkTeamsConnection(config: ResolvedTeamsConfig, tokens: TeamsTokenClient, keys: BotFrameworkKeyStore): Promise<ConnectionCheckResult> {
  const checks = [await tokenCheck(config, tokens), await keysCheck(config, keys), endpointCheck(config.webhookUrl)];
  return { ok: checks.every((check) => check.ok), checks };
}
