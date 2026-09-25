import 'server-only';
import { readFileSync } from 'node:fs';

/**
 * A setting from the environment. `NAME` wins; otherwise `NAME_FILE` names a file holding it (how secrets arrive
 * on the VPS: files on the ocso secrets volume). Read on every call, so a rotated file is picked up without a restart.
 */
function setting(name: string): string | undefined {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  const file = process.env[`${name}_FILE`]?.trim();
  if (!file) return undefined;
  try {
    return readFileSync(file, 'utf8').trim() || undefined;
  } catch (err) {
    console.error(`[env] cannot read ${name}_FILE (${file}): ${(err as Error).message}`);
    return undefined;
  }
}

export type EmailProvider = 'cloudflare' | 'resend' | 'log';

export function serverEnv() {
  const provider = (process.env['EMAIL_PROVIDER']?.trim() || 'cloudflare') as EmailProvider;
  const env = {
    accountId: setting('CLOUDFLARE_ACCOUNT_ID'),
    apiToken: setting('CLOUDFLARE_API_TOKEN'),
    databaseId: setting('SITE_D1_DATABASE_ID'),
    emailProvider: provider,
    resendKey: provider === 'resend' ? setting('RESEND_API_KEY') : undefined,
    from: process.env['EMAIL_FROM']?.trim() || 'OCSO <ocso@winsenlabs.dev>',
    replyTo: process.env['EMAIL_REPLY_TO']?.trim() || 'hello@winsenlabs.com',
    slackEmail: setting('SLACK_NOTIFY_EMAIL'),
    /** Testing only: every email (acknowledgement included) goes here instead, with SUBJECT_PREFIX. */
    redirectTo: process.env['EMAIL_REDIRECT_ALL_TO']?.trim() || undefined,
    subjectPrefix: process.env['EMAIL_SUBJECT_PREFIX'] ?? '',
  };
  const missing = Object.entries({
    CLOUDFLARE_ACCOUNT_ID: env.accountId,
    CLOUDFLARE_API_TOKEN: env.apiToken,
    SITE_D1_DATABASE_ID: env.databaseId,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  return { ...env, missing };
}
