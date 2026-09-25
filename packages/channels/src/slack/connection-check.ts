import { z } from 'zod';
import type { ChannelFetch, ConnectionCheck, ConnectionCheckResult } from '../contract/types.js';
import { safeProviderText } from '../common/redact.js';
import { slackSecretValues, type ResolvedSlackConfig } from './config.js';
import { SLACK_SCOPES } from './descriptor.js';
import { SlackWebApi, type SlackResult, type Sleep } from './web-api.js';

/**
 * Read-only "Test" for a Slack channel: `auth.test` proves the bot token and
 * names the workspace and bot user; the granted scopes (Slack's
 * `x-oauth-scopes` header) are compared with the ones the adapter uses; and
 * the Request URL must be public https for Slack to call it. The signing
 * secret cannot be checked from here: Slack proves it on its first request
 * (the Request URL check). Never sends a message.
 */

const AuthTest = z.looseObject({ team: z.string().optional(), team_id: z.string().optional(), user: z.string().optional(), user_id: z.string().optional(), bot_id: z.string().optional() });

function describeFailure(result: Exclude<SlackResult, { kind: 'ok' }>, secrets: readonly string[]): string {
  if (result.kind === 'network') return result.timedOut ? 'Slack did not answer in time' : 'could not reach Slack';
  if (['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive'].includes(result.error)) return `Slack rejected the bot token (${result.error})`;
  return `Slack answered ${safeProviderText(result.error, secrets, 80) || `HTTP ${result.status}`}`;
}

function tokenCheck(result: SlackResult, secrets: readonly string[]): ConnectionCheck {
  const name = 'Bot token';
  if (result.kind !== 'ok') return { name, ok: false, detail: describeFailure(result, secrets), ...(result.kind === 'network' ? {} : { help: 'bot-token-invalid' }) };
  const auth = AuthTest.safeParse(result.body);
  if (!auth.success || !auth.data.bot_id) return { name, ok: false, detail: 'the token is valid but is not a bot token; use the Bot User OAuth Token (xoxb-…)' };
  const team = auth.data.team ? `"${safeProviderText(auth.data.team, secrets, 80)}"` : 'the workspace';
  const user = auth.data.user ? ` as @${safeProviderText(auth.data.user, secrets, 80)}` : '';
  return { name, ok: true, detail: `valid for ${team}${user}` };
}

/**
 * Names each missing scope and what breaks without it. A missing required scope fails the check; a missing
 * optional one (requested for later use) is noted but passes.
 */
function scopeCheck(scopes: string[] | null): ConnectionCheck {
  const name = 'Bot scopes';
  if (scopes === null) return { name, ok: true, detail: 'Slack did not list the granted scopes; the app manifest requests the ones OCSO needs' };
  const missing = SLACK_SCOPES.filter((s) => !scopes.includes(s.scope));
  const required = missing.filter((s) => s.required);
  if (required.length) {
    const what = required.map((s) => `${s.scope} (without it ${s.breaks})`).join('; ');
    return { name, ok: false, detail: `missing ${what}. Add ${required.length === 1 ? 'it' : 'them'} under OAuth & Permissions → Bot Token Scopes, then reinstall the app`, help: 'missing-scope' };
  }
  const granted = `granted: ${SLACK_SCOPES.filter((s) => s.required).map((s) => s.scope).join(', ')}`;
  return missing.length ? { name, ok: true, detail: `${granted}; optional ${missing.map((s) => s.scope).join(', ')} not granted (not used yet)` } : { name, ok: true, detail: `${granted}, ${SLACK_SCOPES.filter((s) => !s.required).map((s) => s.scope).join(', ')}` };
}

function requestUrlCheck(webhookUrl: string | undefined): ConnectionCheck {
  const name = 'Request URL';
  if (webhookUrl?.startsWith('https://')) return { name, ok: true, detail: 'events and button clicks go to this channel’s https webhook' };
  return { name, ok: false, detail: 'Slack only calls public https URLs: set OCSO_PUBLIC_URL to the https origin Slack can reach', help: 'request-url-not-https' };
}

export async function checkSlackConnection(config: ResolvedSlackConfig, fetchImpl: ChannelFetch, sleep?: Sleep): Promise<ConnectionCheckResult> {
  const secrets = slackSecretValues(config);
  const result = await new SlackWebApi(config, fetchImpl, sleep).call('auth.test', {});
  const checks: ConnectionCheck[] = [tokenCheck(result, secrets)];
  if (result.kind === 'ok') checks.push(scopeCheck(result.scopes));
  checks.push(requestUrlCheck(config.webhookUrl));
  return { ok: checks.every((check) => check.ok), checks };
}
