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

/**
 * The likely cause of a refused token request, from the Microsoft Entra error code in the message, with the
 * troubleshooting entry that explains the fix.
 */
export function explainTokenFailure(message: string, config: ResolvedTeamsConfig): { hint: string; help: string } {
  const code = /AADSTS(\d+)/.exec(message)?.[1];
  const single = config.settings.appType === 'SingleTenant';
  if (code === '7000215') return { hint: 'the client secret is wrong: paste the secret’s Value, not its Secret ID', help: 'secret-invalid' };
  if (code === '7000222') return { hint: 'the client secret has expired: create a new one in Certificates & secrets and paste its Value', help: 'secret-expired' };
  if (code === '700016')
    return {
      hint: single
        ? `no app ${config.settings.appId} in tenant ${config.settings.tenantId}: check the Microsoft App ID and the Tenant ID`
        : `app ${config.settings.appId} is not a multi-tenant app: if the Azure Bot is Single Tenant, set App type to SingleTenant with its Tenant ID`,
      help: 'unauthorized',
    };
  if (code === '90002' || code === '900023') return { hint: `tenant ${config.settings.tenantId ?? ''} was not found: check the Directory (tenant) ID`, help: 'unauthorized' };
  return {
    hint: `check the Microsoft App ID, the client secret, and that App type (${config.settings.appType}) matches how the Azure Bot was created`,
    help: 'unauthorized',
  };
}

async function tokenCheck(config: ResolvedTeamsConfig, tokens: TeamsTokenClient): Promise<ConnectionCheck> {
  const name = 'App credentials';
  const result = await tokens.token(config, { fresh: true });
  if (!result.ok) {
    if (result.errorCode !== 'auth_failed') return { name, ok: false, detail: `${result.message}; try again, or check that OCSO can reach Microsoft Entra` };
    const { hint, help } = explainTokenFailure(result.message, config);
    return { name, ok: false, detail: `${result.message}. Likely cause: ${hint}`, help };
  }
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
  return { name, ok: false, detail: 'Azure Bot Service only calls public https endpoints: set OCSO_PUBLIC_URL to the https origin Microsoft can reach', help: 'endpoint-not-https' };
}

export async function checkTeamsConnection(config: ResolvedTeamsConfig, tokens: TeamsTokenClient, keys: BotFrameworkKeyStore): Promise<ConnectionCheckResult> {
  const checks = [await tokenCheck(config, tokens), await keysCheck(config, keys), endpointCheck(config.webhookUrl)];
  return { ok: checks.every((check) => check.ok), checks };
}
