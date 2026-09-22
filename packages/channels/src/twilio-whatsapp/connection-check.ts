import { z } from 'zod';
import type { ConnectionCheck, ConnectionCheckResult } from '../contract/types.js';
import { safeProviderText } from '../common/redact.js';
import { twilioSecretValues, type ResolvedTwilioConfig } from './config.js';
import { TwilioRestClient, type TwilioResult } from './rest-client.js';

/**
 * Read-only "Test" for a Twilio WhatsApp channel: `GET /Accounts/{sid}.json`
 * (fetch the account) never sends a message. It proves the REST credentials
 * and — separately, when an API key is used — the auth token that signs
 * webhooks. The sender itself is only checked by Twilio at send time
 * (error 63007), so it is not claimed here.
 */

const Account = z.looseObject({ status: z.string().optional(), friendly_name: z.string().optional() });

function describeFailure(result: Exclude<TwilioResult, { kind: 'ok' }>, secrets: readonly string[]): string {
  if (result.kind === 'network') return result.timedOut ? 'Twilio did not answer in time' : 'could not reach Twilio';
  if (result.status === 401) return 'Twilio rejected the credentials (HTTP 401)';
  if (result.status === 404) return 'no such account for these credentials (HTTP 404)';
  const text = safeProviderText(result.error.message, secrets, 160);
  return `Twilio answered HTTP ${result.status}${text ? `: ${text}` : ''}`;
}

function accountCheck(name: string, result: TwilioResult, secrets: readonly string[]): ConnectionCheck {
  if (result.kind !== 'ok') return { name, ok: false, detail: describeFailure(result, secrets) };
  const account = Account.safeParse(result.body);
  const status = account.success ? account.data.status : undefined;
  const label = account.success && account.data.friendly_name ? `"${safeProviderText(account.data.friendly_name, secrets, 80)}"` : 'account';
  if (status && status !== 'active') return { name, ok: false, detail: `${label} is ${status}` };
  return { name, ok: true, detail: `${label} is active` };
}

export async function checkTwilioConnection(config: ResolvedTwilioConfig, fetchImpl: typeof fetch): Promise<ConnectionCheckResult> {
  const client = new TwilioRestClient(config, fetchImpl);
  const secrets = twilioSecretValues(config);
  const url = client.accountUrl();
  const usesApiKey = Boolean(config.settings.apiKeySid && config.secrets.apiKeySecret);
  const checks: ConnectionCheck[] = [accountCheck(usesApiKey ? 'API key' : 'Account SID + auth token', await client.getJson(url), secrets)];
  if (usesApiKey) {
    const tokenAuth = `Basic ${Buffer.from(`${config.settings.accountSid}:${config.secrets.authToken}`, 'utf8').toString('base64')}`;
    const signing = accountCheck('Auth token (signs webhooks)', await client.getJson(url, tokenAuth), secrets);
    checks.push(signing.ok ? { ...signing, detail: 'valid — webhook signatures can be verified' } : signing);
  }
  if (config.settings.statusCallback) {
    const https = config.webhookUrl?.startsWith('https://') ?? false;
    checks.push({
      name: 'Delivery statuses',
      ok: https,
      detail: https ? 'requested per message at the webhook URL' : 'need an https public URL (OCSO_PUBLIC_URL); set the status callback in Twilio instead, or turn this off',
    });
  }
  return { ok: checks.every((check) => check.ok), checks };
}
